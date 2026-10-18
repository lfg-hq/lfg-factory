import { and, asc, eq, gt, or, sql } from 'drizzle-orm';
import { db } from '../config/db.ts';
import { conversationContexts, messages } from '../db/schema/chat.ts';
import { estimateContextTokens, handoffMessage, summarizeEvidence, type Summarizer } from './context-compaction.ts';

/** Called only after the normal conversation access check. Original messages are never modified. */
/**
 * `compact: false` only reads the saved checkpoint, so a turn can start without waiting
 * on summarization; the caller refreshes it in the background after the turn.
 */
export async function loadConversationHandoff(conversationId: string, summarize: Summarizer, store = db, opts: { compact?: boolean } = {}) {
  const [saved] = await store.select().from(conversationContexts).where(eq(conversationContexts.conversationId, conversationId));
  // Read textual evidence only; recent tool output is loaded separately by the caller.
  const rows = await store.select({ id: messages.id, role: messages.role, content: messages.content,
    createdAt: messages.createdAt, userRole: messages.userRole, files: messages.contentIfFile })
    .from(messages).where(and(eq(messages.conversationId, conversationId), sql`coalesce(${messages.userRole}, '') <> 'operation_status'`, saved ? or(
      gt(messages.createdAt, saved.throughAt), and(eq(messages.createdAt, saved.throughAt), gt(messages.id, saved.throughId))) : undefined))
    .orderBy(asc(messages.createdAt), asc(messages.id));
  let summary = saved?.summary ?? '';
  // Retain the latest 20 exact rows. Compact before they would disappear from history.
  const old = opts.compact !== false && rows.length > 40 ? rows.slice(0, rows.length - 20) : [];
  if (old.length) {
    let batch = '';
    for (const row of old) {
      const text = JSON.stringify(row);
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
