import { generateText } from 'ai';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { db } from '../../config/db.ts';
import { env } from '../../config/env.ts';
import { users } from '../../db/schema/index.ts';
import { getModel } from '../../ai/provider.ts';
import { sendEmail } from '../../utils/email.ts';
import { ventureConversations } from '../db/schema.ts';
import { ventureLog } from '../request-log.ts';

// Founders who hit the AI provider's capacity limit are told "we'll let you know
// when you can resume". This keeps that promise: while anyone is waiting, a tiny
// probe checks the chat model every few minutes; once it answers, each waiting
// founder gets one email with a link back to their conversation.
const CHECK_EVERY_MS = 5 * 60_000;
let timer: ReturnType<typeof setInterval> | null = null;
let checking = false;

export async function recordCapacityWait(conversationId: string) {
  await db.update(ventureConversations).set({ capacityWaitAt: new Date() })
    .where(and(eq(ventureConversations.id, conversationId), isNull(ventureConversations.capacityWaitAt))).catch(() => {});
  watchCapacity();
}

// A founder who gets a reply on their own no longer needs the email.
export async function clearCapacityWait(conversationId: string) {
  await db.update(ventureConversations).set({ capacityWaitAt: null })
    .where(and(eq(ventureConversations.id, conversationId), isNotNull(ventureConversations.capacityWaitAt))).catch(() => {});
}

// Runs at startup too, so waits recorded before a restart are still honoured.
export function watchCapacity() {
  if (timer || process.env.NODE_ENV === 'test') return;
  timer = setInterval(() => { void checkCapacity(); }, CHECK_EVERY_MS);
  (timer as any).unref?.();
}

const probe = async () => {
  await generateText({ model: getModel(env.VENTURE_CHAT_MODEL || 'gpt-6.1-terra', undefined, { allowEnvFallback: true }), prompt: 'Reply with OK.', maxOutputTokens: 16, maxRetries: 0 });
};

export async function checkCapacity(available: () => Promise<unknown> = probe, send = sendEmail) {
  if (checking) return 0;
  checking = true;
  const started = performance.now();
  try {
    const waiting = await db.select({ id: ventureConversations.id, title: ventureConversations.title, email: users.email, name: users.name })
      .from(ventureConversations).innerJoin(users, eq(users.id, ventureConversations.userId))
      .where(and(isNotNull(ventureConversations.capacityWaitAt), isNull(ventureConversations.archivedAt)));
    if (!waiting.length) { if (timer) { clearInterval(timer); timer = null; } return 0; }
    try { await available(); }
    catch { ventureLog('venture.capacity.still_limited', 'capacity', started, 'pending', { waiting: waiting.length }); return 0; }
    let notified = 0;
    for (const w of waiting) {
      // Clear first: a founder is never emailed twice for the same wait.
      const [claimed] = await db.update(ventureConversations).set({ capacityWaitAt: null })
        .where(and(eq(ventureConversations.id, w.id), isNotNull(ventureConversations.capacityWaitAt))).returning({ id: ventureConversations.id });
      if (!claimed || !w.email) continue;
      if (await send(resumeEmail(w))) notified++;
    }
    ventureLog('venture.capacity.resumed', 'capacity', started, 'success', { waiting: waiting.length, notified });
    return notified;
  } finally { checking = false; }
}

const escape = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
function resumeEmail(w: { id: string; title: string; email: string; name: string | null }) {
  const link = `${(env.APP_URL || 'https://lfg.run').replace(/\/$/, '')}/venture/chat?c=${encodeURIComponent(w.id)}`;
  const hi = w.name ? `Hi ${w.name.split(' ')[0]},` : 'Hi,';
  const body = `The LFG venture analyst has capacity again, so you can pick up where you left off on “${w.title}”. Your conversation is saved.`;
  return {
    to: w.email,
    subject: 'You can resume with the LFG venture analyst',
    text: `${hi}\n\n${body}\n\nResume: ${link}\n\nLFG Ventures`,
    html: `<p>${escape(hi)}</p><p>${escape(body)}</p><p><a href="${link}">Resume your conversation</a></p><p>LFG Ventures</p>`,
  };
}
