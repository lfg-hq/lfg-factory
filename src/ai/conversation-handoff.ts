import { and, asc, eq, gt, or, sql } from 'drizzle-orm';
import { db } from '../config/db.ts';
import { conversationContexts, messages } from '../db/schema/chat.ts';
import { contextBudget, estimateContextTokens, handoffMessage, summarizeEvidence, type Summarizer } from './context-compaction.ts';

/** Called only after the normal conversation access check. Original messages are never modified. */
/**
 * `compact: false` only reads the saved checkpoint, so a turn can start without waiting
 * on summarization; the caller refreshes it in the background after the turn.
 */
export async function loadConversationHandoff(conversationId: string, summarize: Summarizer, store = db, opts: { compact?: boolean } = {}) {
  const [saved] = await store.select().from(conversationContexts).where(eq(conversationContexts.conversationId, conversationId));
  // Read textual evidence only; recent tool output is loaded separately by the caller.
  const rows = await store.select({ id: messages.id, role: messages.role, content: messages.content,
    createdAt: messages.createdAt, userRole: messages.userRole, files: messages.contentIfFile, steps: messages.toolSteps })
    .from(messages).where(and(eq(messages.conversationId, conversationId), sql`coalesce(${messages.userRole}, '') <> 'operation_status'`, saved ? or(
      gt(messages.createdAt, saved.throughAt), and(eq(messages.createdAt, saved.throughAt), gt(messages.id, saved.throughId))) : undefined))
    .orderBy(asc(messages.createdAt), asc(messages.id));
  let summary = saved?.summary ?? '';
  // Keep the newest rows exact: at most 20, and only as many as fit a quarter of the
  // budget, counting the tool steps each turn replays (capped as the replay caps them).
  // Counting rows alone let a few large turns start every request near the condensing
  // threshold, so most turns condensed mid-way.
  const exactBudget = Math.floor(contextBudget() * .25);
  const size = (row: typeof rows[number]) => estimateContextTokens(String(row.content ?? '')) +
    (Array.isArray(row.steps) ? Math.min(estimateContextTokens(JSON.stringify(row.steps)), 4000) : 0);
  let keepFrom = rows.length, kept = 0;
  for (let i = rows.length - 1; i >= 0 && rows.length - i <= 20; i--) {
    const next = kept + size(rows[i]!);
    if (next > exactBudget && rows.length - i > 4) break;
    kept = next; keepFrom = i;
  }
  const total = rows.reduce((n, row) => n + size(row), 0);
  const oversized = keepFrom > 0 && total > contextBudget() * .35;
  const old = opts.compact !== false && (rows.length > 40 || oversized) ? rows.slice(0, keepFrom) : [];
  if (old.length) {
    let batch = '';
    for (const row of old) {
      // Summaries read the conversation text; replayed tool output is evidence only.
      const { steps: _steps, ...textual } = row;
      const text = JSON.stringify(textual);
      const bounded = text.length > 24000 ? text.slice(0, 16000) + '\n[Historical item shortened; retrieve message ' + row.id + ']\n' + text.slice(-8000) : text;
      if (batch && estimateContextTokens(batch + bounded) > 10000) {
        summary = await summarizeEvidence('Previous handoff:\n' + summary + '\nHistorical messages:\n' + batch, summarize);
        batch = '';
      }
      batch += bounded + '\n';
    }
    if (batch) summary = await summarizeEvidence('Previous handoff:\n' + summary + '\nHistorical messages:\n' + batch, summarize);
    const last = old.at(-1)!;
    // Compare-and-swap prevents a concurrent turn overwriting a newer checkpoint.
    if (saved) await store.update(conversationContexts).set({summary, throughId:last.id, throughAt:last.createdAt})
      .where(and(eq(conversationContexts.conversationId, conversationId), eq(conversationContexts.throughId, saved.throughId)));
    else await store.insert(conversationContexts).values({conversationId, summary, throughId:last.id, throughAt:last.createdAt}).onConflictDoNothing();
  }
  const checkpoint = old.at(-1);
  return summary ? { message: handoffMessage(summary), throughId: checkpoint?.id ?? saved!.throughId, throughAt: checkpoint?.createdAt ?? saved!.throughAt } : null;
}
