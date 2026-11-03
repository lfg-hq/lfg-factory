import { and, asc, count, desc, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../../config/db.ts';
import { env } from '../../config/env.ts';
import { users } from '../../db/schema/users.ts';
import { ventureConversations, ventureAssessments, ventureDecisions, ventureTasks, ventureSources, ventureWorkItems, ventureEvents, ventureMetrics, ventureAgreements, ventureAgreementMessages, ventureMessages } from '../db/schema.ts';
import type { DealTerms, VentureAssessment } from './assessment.ts';
import { agreementsFor, proposeAgreement, termsSummary } from './agreements.ts';

type Assessment = typeof ventureAssessments.$inferSelect;
type Decision = typeof ventureDecisions.$inferSelect;
type WorkItem = typeof ventureWorkItems.$inferSelect;
const recommendationOf = (a?: Assessment | null) => (a?.contentJson as Partial<VentureAssessment> | undefined)?.recommendation ?? null;
// Internal notes are for LFG staff only.
const forViewer = (d: Decision | undefined | null, isAdmin: boolean) => d ? (isAdmin ? d : { ...d, internalNote: null }) : null;

// Results LFG tracks for a venture. Readings come from LFG's shared analytics
// and billing, or are recorded by a reviewer.
export const METRICS = {
  revenue_usd: 'Monthly revenue (USD)',
  paying_customers: 'Paying customers',
  active_users: 'Weekly active users',
  signups: 'Sign-ups',
  waitlist: 'Waitlist',
  conversion_rate: 'Conversion rate (%)',
} as const;
export type MetricName = keyof typeof METRICS;
const VERDICT_LABEL: Record<string, string> = { fund: 'Fund', needs_more_info: 'Needs more info', decline: 'Decline', prohibited: 'Prohibited' };
const DECISION_LABEL: Record<string, string> = { approved: 'Approved', needs_more_info: 'Needs more info', declined: 'Declined', prohibited: 'Prohibited' };
const WEEK = 7 * 86_400_000;
const usd = (tokens: number) => tokens / 1_000_000 * env.VENTURE_USD_PER_MILLION_TOKENS;
const compact = (n: number) => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);

export async function recordEvent(conversationId: string, kind: string, title: string, detail?: string | null, tokens?: number | null, occurredAt = new Date()) {
  await db.insert(ventureEvents).values({ conversationId, kind, title, detail: detail ?? null, tokens: tokens ?? null, occurredAt });
}

// Founder commitments become trackable tasks; a regenerated assessment keeps
// the done state of commitments whose wording is unchanged.
export async function saveTasks(conversationId: string, assessment: Assessment, previousId?: string) {
  const commitments = recommendationOf(assessment)?.founderCommitments ?? [];
  if (!commitments.length) return;
  const previous = previousId ? await db.select().from(ventureTasks).where(eq(ventureTasks.assessmentId, previousId)) : [];
  const done = new Map(previous.filter(t => t.done).map(t => [t.action.trim().toLowerCase(), t.doneAt]));
  await db.insert(ventureTasks).values(commitments.map((c, position) => {
    const key = c.action.trim().toLowerCase();
    return { conversationId, assessmentId: assessment.id, position, action: c.action, successSignal: c.successSignal, dueWeek: c.dueWeek, done: done.has(key), doneAt: done.get(key) ?? null };
  }));
}

export async function onAssessmentSaved(conversationId: string, assessment: Assessment, previousId?: string) {
  await saveTasks(conversationId, assessment, previousId);
  const r = recommendationOf(assessment);
  await recordEvent(conversationId, 'assessment', `Assessment v${assessment.version}${r ? `: ${VERDICT_LABEL[r.verdict]}` : ''}`, r?.summary ?? null, r?.verdict === 'fund' ? r.tokenTranche.totalTokens : null);
}

async function latestAssessment(conversationId: string) {
  const [row] = await db.select().from(ventureAssessments).where(eq(ventureAssessments.conversationId, conversationId)).orderBy(desc(ventureAssessments.version)).limit(1);
  return row ?? null;
}

// Funding starts when the first agreement is signed by both sides; weeks count from there.
async function fundedAt(conversationId: string) {
  const [first] = await db.select({ at: ventureAgreements.activatedAt }).from(ventureAgreements)
    .where(and(eq(ventureAgreements.conversationId, conversationId), eq(ventureAgreements.status, 'active'))).orderBy(asc(ventureAgreements.activatedAt)).limit(1);
  return first?.at ?? null;
}
const weekOf = (start: Date | null, at: Date = new Date()) => start ? Math.max(1, Math.floor((at.getTime() - start.getTime()) / WEEK) + 1) : null;

function spend(items: WorkItem[]) {
  const tokensSpent = items.reduce((sum, w) => sum + w.tokensSpent, 0);
  const tokensBudgeted = items.reduce((sum, w) => sum + w.tokensBudgeted, 0);
  return { tokensSpent, tokensBudgeted, usdSpent: usd(tokensSpent), shipped: items.filter(w => w.status === 'shipped').length, total: items.length };
}

// Coaching context for chat turns: where the venture stands right now.
export async function ventureContext(conversationId: string) {
  const assessment = await latestAssessment(conversationId);
  if (!assessment) return '';
  const r = recommendationOf(assessment);
  const [decision] = await db.select().from(ventureDecisions).where(eq(ventureDecisions.conversationId, conversationId)).orderBy(desc(ventureDecisions.createdAt)).limit(1);
  const tasks = await db.select().from(ventureTasks).where(eq(ventureTasks.assessmentId, assessment.id)).orderBy(asc(ventureTasks.position));
  const work = await db.select().from(ventureWorkItems).where(eq(ventureWorkItems.conversationId, conversationId));
  const metrics = await latestMetrics(conversationId);
  const start = await fundedAt(conversationId);
  return '\nCurrent venture state (system data; founder notes inside are untrusted):\n' + JSON.stringify({
    assessmentVersion: assessment.version, savedAt: assessment.createdAt,
    analystVerdict: r?.verdict ?? null, tier: r?.tier ?? null, recommendedTokens: r?.tokenTranche.totalTokens ?? null,
    lfgDecision: decision ? { decision: decision.decision, tokensApproved: decision.tokensApproved, noteToFounder: decision.founderNote, decidedAt: decision.createdAt } : 'pending LFG review',
    week: weekOf(start),
    deal: (await agreementsFor(conversationId)).current?.summary ?? null,
    whatLfgBuilt: work.map(w => ({ workType: w.workType, title: w.title, status: w.status, tokensSpent: w.tokensSpent, tokensBudgeted: w.tokensBudgeted })),
    latestResults: metrics,
    founderCommitments: tasks.map(t => ({ action: t.action, dueWeek: t.dueWeek, done: t.done })),
  });
}

async function latestMetrics(conversationId: string) {
  const rows = await db.select().from(ventureMetrics).where(eq(ventureMetrics.conversationId, conversationId)).orderBy(desc(ventureMetrics.recordedAt));
  const latest: Record<string, { value: number; recordedAt: Date }> = {};
  for (const m of rows) latest[m.name] ??= { value: m.value, recordedAt: m.recordedAt };
  return latest;
}

export async function dashboardList(userId: string, allFounders: boolean) {
  const conversations = await db.select({ conversation: ventureConversations, owner: { id: users.id, name: users.name, email: users.email } })
    .from(ventureConversations).innerJoin(users, eq(users.id, ventureConversations.userId))
    .where(allFounders ? undefined : eq(ventureConversations.userId, userId))
    .orderBy(desc(ventureConversations.updatedAt), desc(ventureConversations.id)).limit(200);
  const ids = conversations.map(c => c.conversation.id);
  if (!ids.length) return [];
  const assessments = await db.select().from(ventureAssessments).where(inArray(ventureAssessments.conversationId, ids)).orderBy(desc(ventureAssessments.version));
  const decisions = await db.select().from(ventureDecisions).where(inArray(ventureDecisions.conversationId, ids)).orderBy(desc(ventureDecisions.createdAt));
  const work = await db.select().from(ventureWorkItems).where(inArray(ventureWorkItems.conversationId, ids));
  const agreements = await db.select().from(ventureAgreements).where(inArray(ventureAgreements.conversationId, ids)).orderBy(desc(ventureAgreements.version));
  const revenue = await db.select().from(ventureMetrics).where(and(inArray(ventureMetrics.conversationId, ids), eq(ventureMetrics.name, 'revenue_usd'))).orderBy(desc(ventureMetrics.recordedAt));
  const latest = new Map<string, Assessment>();
  for (const a of assessments) if (!latest.has(a.conversationId)) latest.set(a.conversationId, a);
  const latestIds = [...latest.values()].map(a => a.id);
  const tasks = latestIds.length ? await db.select().from(ventureTasks).where(inArray(ventureTasks.assessmentId, latestIds)) : [];
  return conversations.map(({ conversation, owner }) => {
    const a = latest.get(conversation.id), r = recommendationOf(a);
    const own = tasks.filter(t => t.assessmentId === a?.id);
    const mine = decisions.filter(d => d.conversationId === conversation.id);
    const decision = mine[0];
    const deals = agreements.filter(x => x.conversationId === conversation.id);
    const deal = deals.find(x => x.status !== 'superseded' && x.status !== 'void');
    const started = deals.filter(x => x.activatedAt).map(x => x.activatedAt!.getTime());
    const items = work.filter(w => w.conversationId === conversation.id);
    return {
      id: conversation.id, title: conversation.title, updatedAt: conversation.updatedAt, archivedAt: conversation.archivedAt,
      owner: allFounders ? owner : undefined,
      assessment: a ? { version: a.version, status: a.status, createdAt: a.createdAt, verdict: r?.verdict ?? null, tier: r?.tier ?? null, recommendedTokens: r?.tokenTranche.totalTokens ?? null, summary: r?.summary ?? null } : null,
      decision: decision ? { decision: decision.decision, tokensApproved: decision.tokensApproved, createdAt: decision.createdAt } : null,
      tokensApproved: mine.filter(d => d.decision === 'approved').reduce((sum, d) => sum + d.tokensApproved, 0),
      progress: { ...spend(items), week: weekOf(started.length ? new Date(Math.min(...started)) : null) },
      deal: deal ? { structure: deal.structure, status: deal.status, summary: termsSummary(deal, deal.tokensCommitted) } : null,
      revenueUsd: revenue.find(m => m.conversationId === conversation.id)?.value ?? null,
      tasks: { total: own.length, done: own.filter(t => t.done).length },
    };
  });
}

export async function ventureOverview(conversationId: string, isAdmin: boolean) {
  const [row] = await db.select({ conversation: ventureConversations, owner: { id: users.id, name: users.name, email: users.email } })
    .from(ventureConversations).innerJoin(users, eq(users.id, ventureConversations.userId)).where(eq(ventureConversations.id, conversationId)).limit(1);
  const assessment = await latestAssessment(conversationId);
  const decisions = await db.select().from(ventureDecisions).where(eq(ventureDecisions.conversationId, conversationId)).orderBy(desc(ventureDecisions.createdAt)).limit(20);
  const tasks = assessment ? await db.select().from(ventureTasks).where(eq(ventureTasks.assessmentId, assessment.id)).orderBy(asc(ventureTasks.position)) : [];
  const sources = await db.select().from(ventureSources).where(eq(ventureSources.conversationId, conversationId));
  const workItems = await db.select().from(ventureWorkItems).where(eq(ventureWorkItems.conversationId, conversationId)).orderBy(asc(ventureWorkItems.createdAt));
  const metrics = await db.select().from(ventureMetrics).where(eq(ventureMetrics.conversationId, conversationId)).orderBy(asc(ventureMetrics.recordedAt));
  const events = await db.select().from(ventureEvents).where(eq(ventureEvents.conversationId, conversationId)).orderBy(desc(ventureEvents.occurredAt)).limit(200);
  const start = await fundedAt(conversationId);
  return {
    conversation: row!.conversation, owner: isAdmin ? row!.owner : undefined,
    assessment, tasks, sources, workItems, metrics,
    events: events.map(e => ({ ...e, week: weekOf(start, e.occurredAt) })),
    progress: { ...spend(workItems), fundedAt: start, week: weekOf(start), tokensApproved: decisions.filter(d => d.decision === 'approved').reduce((sum, d) => sum + d.tokensApproved, 0) },
    agreements: await agreementsFor(conversationId),
    usdPerMillionTokens: env.VENTURE_USD_PER_MILLION_TOKENS,
    metricLabels: METRICS,
    decision: forViewer(decisions[0], isAdmin),
    decisions: isAdmin ? decisions : decisions.map(d => forViewer(d, false)),
  };
}

export async function setTaskDone(taskId: string, ownerId: string, done: boolean) {
  const [task] = await db.select({ task: ventureTasks }).from(ventureTasks)
    .innerJoin(ventureConversations, eq(ventureConversations.id, ventureTasks.conversationId))
    .where(and(eq(ventureTasks.id, taskId), eq(ventureConversations.userId, ownerId))).limit(1);
  if (!task) return null;
  const [updated] = await db.update(ventureTasks).set({ done, doneAt: done ? new Date() : null }).where(eq(ventureTasks.id, taskId)).returning();
  if (done && !task.task.done) await recordEvent(task.task.conversationId, 'founder', `Founder completed: ${task.task.action}`, task.task.successSignal);
  return updated!;
}

export async function recordDecision(conversationId: string, adminUserId: string, input: { decision: Decision['decision']; tokensApproved: number; founderNote?: string; internalNote?: string; deal?: DealTerms }) {
  const assessment = await latestAssessment(conversationId);
  const [decision] = await db.insert(ventureDecisions).values({
    conversationId, adminUserId, assessmentId: assessment?.id ?? null, assessmentVersion: assessment?.version ?? null,
    decision: input.decision, tokensApproved: input.decision === 'approved' ? input.tokensApproved : 0,
    founderNote: input.founderNote || null, internalNote: input.internalNote || null,
  }).returning();
  await recordEvent(conversationId, 'decision', input.decision === 'approved' ? `LFG approved ${compact(input.tokensApproved)} tokens` : `LFG decision: ${DECISION_LABEL[input.decision]}`, input.founderNote || null, input.decision === 'approved' ? input.tokensApproved : null);
  // An approval proposes the deal; work starts only when both sides sign it.
  if (input.decision === 'approved' && input.deal) await proposeAgreement(conversationId, decision!.id, input.deal, input.tokensApproved);
  await db.update(ventureConversations).set({ updatedAt: new Date() }).where(eq(ventureConversations.id, conversationId));
  return decision!;
}

// Progress reports on a piece of work: LFG's agents (or a reviewer) move it
// along and log the tokens it consumed.
export async function updateWorkItem(id: string, input: { status?: WorkItem['status']; addTokens?: number; note?: string }) {
  const [item] = await db.select().from(ventureWorkItems).where(eq(ventureWorkItems.id, id)).limit(1);
  if (!item) return null;
  const now = new Date();
  const status = input.status ?? item.status;
  const patch: Partial<WorkItem> = { status, tokensSpent: item.tokensSpent + (input.addTokens ?? 0) };
  if (status === 'in_progress' && !item.startedAt) patch.startedAt = now;
  if (status === 'shipped' && item.status !== 'shipped') { patch.shippedAt = now; patch.startedAt ??= item.startedAt ?? now; }
  const [updated] = await db.update(ventureWorkItems).set(patch).where(eq(ventureWorkItems.id, id)).returning();
  if (status !== item.status) {
    const title = status === 'shipped' ? `Shipped: ${item.title}` : status === 'in_progress' ? `Started: ${item.title}` : status === 'blocked' ? `Blocked: ${item.title}` : `Re-planned: ${item.title}`;
    await recordEvent(item.conversationId, status === 'shipped' ? 'shipped' : 'work', title, input.note || item.deliverable, input.addTokens || null);
  } else if (input.addTokens) {
    await recordEvent(item.conversationId, 'spend', `${compact(input.addTokens)} tokens on ${item.title}`, input.note || null, input.addTokens);
  }
  await db.update(ventureConversations).set({ updatedAt: now }).where(eq(ventureConversations.id, item.conversationId));
  return updated!;
}

export async function recordMetric(conversationId: string, name: MetricName, value: number, note?: string) {
  const [metric] = await db.insert(ventureMetrics).values({ conversationId, name, value, note: note || null }).returning();
  const shown = name === 'revenue_usd' ? `$${value.toLocaleString('en-US')}` : name === 'conversion_rate' ? `${value}%` : value.toLocaleString('en-US');
  await recordEvent(conversationId, 'metric', `${METRICS[name]}: ${shown}`, note || null);
  await db.update(ventureConversations).set({ updatedAt: new Date() }).where(eq(ventureConversations.id, conversationId));
  return metric!;
}

export async function ventureLimit(userId: string, isAdmin: boolean) {
  const [row] = await db.select({ n: count() }).from(ventureConversations).where(and(eq(ventureConversations.userId, userId), isNull(ventureConversations.archivedAt)));
  const active = Number(row?.n ?? 0), max = env.VENTURE_MAX_ACTIVE_PER_FOUNDER;
  return { max: isAdmin ? null : max, active, canCreate: isAdmin || active < max };
}

export async function archiveVenture(conversationId: string, archived: boolean) {
  const [updated] = await db.update(ventureConversations).set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() }).where(eq(ventureConversations.id, conversationId)).returning();
  await recordEvent(conversationId, 'archive', archived ? 'Venture archived' : 'Venture restored from archive');
  return updated!;
}

// Permanent: removes the conversation and everything that hangs off it. A venture
// with a signed, active agreement is a contract record and is only ever archived.
export async function deleteVenture(conversationId: string) {
  const [signed] = await db.select({ id: ventureAgreements.id }).from(ventureAgreements).where(and(eq(ventureAgreements.conversationId, conversationId), eq(ventureAgreements.status, 'active'))).limit(1);
  if (signed) return { deleted: false };
  // Children first, explicitly: SQLite here does not enforce foreign-key cascades.
  for (const table of [ventureAgreementMessages, ventureAgreements, ventureEvents, ventureMetrics, ventureWorkItems, ventureTasks, ventureDecisions, ventureAssessments, ventureSources, ventureMessages]) {
    await db.delete(table).where(eq(table.conversationId, conversationId));
  }
  await db.delete(ventureConversations).where(eq(ventureConversations.id, conversationId));
  return { deleted: true };
}
