import { and, asc, eq, gt, or, sql } from 'drizzle-orm';
import { db } from '../config/db.ts';
import { conversationContexts, messages } from '../db/schema/chat.ts';
import { contextBudget, estimateContextTokens, handoffMessage, ledgerLines, splitLedger, summarizeEvidence, summaryLimit, withLedger, type Summarizer } from './context-compaction.ts';
import { toolDigest } from './history-budget.ts';

/** Unsummarized messages beyond which a turn condenses before it starts, so none fall outside the loaded window. */
export const OVERDUE_ROWS = 80;

/** Called only after the normal conversation access check. Original messages are never modified. */
/**
 * `compact: false` only reads the saved checkpoint, so a turn can start without waiting
 * on summarization; the caller refreshes it in the background after the turn.
 * `compact: 'overdue'` summarizes only when the backlog has outgrown what a turn loads
 * (background refreshes kept failing), so history never gets a silent hole.
 */
export async function loadConversationHandoff(conversationId: string, summarize: Summarizer, store = db, opts: { compact?: boolean | 'overdue'; budget?: number } = {}) {
  const [saved] = await store.select().from(conversationContexts).where(eq(conversationContexts.conversationId, conversationId));
  const rows = await store.select({ id: messages.id, role: messages.role, content: messages.content,
    createdAt: messages.createdAt, userRole: messages.userRole, files: messages.contentIfFile, steps: messages.toolSteps })
    .from(messages).where(and(eq(messages.conversationId, conversationId), sql`coalesce(${messages.userRole}, '') <> 'operation_status'`, saved ? or(
      gt(messages.createdAt, saved.throughAt), and(eq(messages.createdAt, saved.throughAt), gt(messages.id, saved.throughId))) : undefined))
    .orderBy(asc(messages.createdAt), asc(messages.id));
  let summary = saved?.summary ?? '';
  // Keep the newest rows exact: at most 20, and only as many as fit a quarter of the
  // budget, counting the tool steps each turn replays in full.
  const budget = opts.budget ?? contextBudget();
  const exactBudget = Math.floor(budget * .25);
  const size = (row: typeof rows[number]) => estimateContextTokens(String(row.content ?? '')) +
    (Array.isArray(row.steps) ? Math.min(estimateContextTokens(JSON.stringify(row.steps)), 40_000) : 0);
  let keepFrom = rows.length, kept = 0;
  for (let i = rows.length - 1; i >= 0 && rows.length - i <= 20; i--) {
    const next = kept + size(rows[i]!);
    if (next > exactBudget && rows.length - i > 4) break;
    kept = next; keepFrom = i;
  }
  const total = rows.reduce((n, row) => n + size(row), 0);
  const oversized = keepFrom > 0 && total > budget * .35;
  const due = opts.compact === 'overdue' ? rows.length > OVERDUE_ROWS : opts.compact !== false && (rows.length > 40 || oversized);
  const old = due ? rows.slice(0, keepFrom) : [];
  if (old.length) {
    const maxChars = summaryLimit(budget);
    // The ledger is mechanical: lifted out before the model sees the handoff, re-attached after.
    const previous = splitLedger(summary);
    const ledger = [...previous.lines];
    let body = previous.body;
    let batch = '';
    const flush = async () => {
      body = await summarizeEvidence('Previous handoff:\n' + body + '\nHistorical messages:\n' + batch, summarize, maxChars);
      batch = '';
    };
    for (const row of old) {
      const { steps, ...textual } = row;
      // The reply text plus one line per tool call, so work the reply never mentioned survives.
      const activity = Array.isArray(steps) ? toolDigest(steps) : '';
      if (Array.isArray(steps)) ledger.push(...ledgerLines(steps));
      const text = JSON.stringify(textual) + (activity ? '\nTool activity in this turn:\n' + activity : '');
      const bounded = text.length > 24000 ? text.slice(0, 16000) + '\n[Historical item shortened; retrieve message ' + row.id + ']\n' + text.slice(-8000) : text;
      if (batch && estimateContextTokens(batch + bounded) > 30000) await flush();
      batch += bounded + '\n';
    }
    if (batch) await flush();
    summary = withLedger(body, ledger);
    const last = old.at(-1)!;
    // Compare-and-swap prevents a concurrent turn overwriting a newer checkpoint.
    if (saved) await store.update(conversationContexts).set({summary, throughId:last.id, throughAt:last.createdAt})
      .where(and(eq(conversationContexts.conversationId, conversationId), eq(conversationContexts.throughId, saved.throughId)));
    else await store.insert(conversationContexts).values({conversationId, summary, throughId:last.id, throughAt:last.createdAt}).onConflictDoNothing();
  }
  const checkpoint = old.at(-1);
  return summary ? { message: handoffMessage(summary), throughId: checkpoint?.id ?? saved!.throughId, throughAt: checkpoint?.createdAt ?? saved!.throughAt } : null;
}

/**
 * Save the handoff a turn wrote while condensing mid-way, as the conversation's checkpoint.
 * It used to be discarded: the next turn rebuilt its context from the database by a
 * different route and the two never agreed. `through` is the newest stored message the
 * handoff fully covers; the turn in progress is stored later and replayed in full.
 */
export async function saveConversationCheckpoint(conversationId: string, summary: string, through: { id: string; createdAt: Date }, store = db): Promise<void> {
  await store.insert(conversationContexts).values({ conversationId, summary, throughId: through.id, throughAt: through.createdAt })
    .onConflictDoUpdate({ target: conversationContexts.conversationId, set: { summary, throughId: through.id, throughAt: through.createdAt } });
}
