import { and, asc, desc, eq, ne } from 'drizzle-orm';
import { db } from '../../config/db.ts';
import { env } from '../../config/env.ts';
import { users } from '../../db/schema/users.ts';
import { ventureAgreements, ventureAgreementMessages, ventureAssessments, ventureConversations, ventureDecisions, ventureWorkItems, ventureTasks } from '../db/schema.ts';
import { dealTermsProblem, type DealTerms, type VentureAssessment } from './assessment.ts';
import { recordEvent } from './dashboard.ts';

type Agreement = typeof ventureAgreements.$inferSelect;
export const DEAL_LABEL = { equity: 'Equity', revenue_share: 'Revenue share', profit_share: 'Profit share' } as const;
const compact = (n: number) => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
const dollars = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: n < 100 ? 2 : 0 }).format(n);
export const tokenValueUsd = (tokens: number) => tokens / 1_000_000 * env.VENTURE_USD_PER_MILLION_TOKENS;

export class AgreementFailure extends Error {
  constructor(public code: string, public status: number, message: string) { super(message); }
}

export function termsSummary(t: DealTerms, tokens: number) {
  if (t.structure === 'equity') return `${t.equityPercent}% equity for ${compact(tokens)} tokens`;
  const what = t.structure === 'revenue_share' ? 'revenue' : 'profit';
  return `${t.revenueSharePercent}% of ${what} until ${t.capMultiple}× (${dollars(tokenValueUsd(tokens) * t.capMultiple!)}) or ${t.termMonths} months`;
}

// The agreement is generated from the agreed terms, never written by the model,
// so its wording is fixed and reviewable. LFG's counsel owns this template.
export function agreementText(input: { version: number; founder: { name: string; email: string }; venture: string; terms: DealTerms; tokens: number; lineItems: { item: string; deliverable?: string; tokens: number }[]; commitments: { action: string; dueWeek: number | null }[] }) {
  const { terms: t, tokens } = input, value = tokenValueUsd(tokens);
  const consideration = t.structure === 'equity'
    ? `In exchange, the Founder grants LFG **${t.equityPercent}% of the fully diluted equity** of the company that operates the Venture. The parties will document this in a standard equity instrument (such as a SAFE or a share issue) within 30 days of the company's incorporation, or of this Agreement if the company already exists.`
    : `In exchange, the Founder pays LFG **${t.revenueSharePercent}% of the Venture's ${t.structure === 'revenue_share' ? 'gross revenue' : 'net profit'}**, monthly in arrears, until the earlier of (a) LFG having received **${t.capMultiple}× the value of the tokens committed (${dollars(value * t.capMultiple!)})**, or (b) **${t.termMonths} months** from the date this Agreement becomes active. LFG takes no equity.`;
  return [
    `# LFG Venture Agreement`,
    `**Version ${input.version}** · Generated ${new Date().toISOString().slice(0, 10)}`,
    ``,
    `This Agreement is between **LFG Inc.** ("LFG") and **${input.founder.name}** (${input.founder.email}) (the "Founder") for the venture **"${input.venture}"** (the "Venture"). It becomes active only when both parties have signed it.`,
    ``,
    `## 1. What LFG provides`,
    `LFG commits **${compact(tokens)} tokens** (about **${dollars(value)}** of agent work at LFG's standard rate of ${dollars(env.VENTURE_USD_PER_MILLION_TOKENS)} per million tokens). LFG's agents spend them on:`,
    ...input.lineItems.map(l => `- **${l.item}** (${compact(l.tokens)} tokens)${l.deliverable ? `: ${l.deliverable}` : ''}`),
    ``,
    `The Venture runs on LFG's shared infrastructure, including hosting, security, authentication, payments, analytics and email, at no extra charge while this Agreement is active. Tokens are not cash and are not paid to the Founder.`,
    ``,
    `## 2. What the Founder commits to`,
    ...(input.commitments.length ? input.commitments.map(c => `- ${c.action}${c.dueWeek !== null ? ` (by week ${c.dueWeek})` : ''}`) : ['- The commitments agreed with the analyst.']),
    `- Share honest progress, results and feedback at each check-in.`,
    ``,
    `## 3. Deal: ${DEAL_LABEL[t.structure]}`,
    consideration,
    ``,
    `## 4. Further tranches`,
    `LFG reviews progress at each check-in and may commit further tokens on new terms. Nothing in this Agreement obliges either party to a further tranche.`,
    ``,
    `## 5. Ownership`,
    `The Founder owns the Venture, its brand and its customer relationships. Work LFG's agents build for the Venture is licensed to it for as long as it operates; LFG keeps ownership of its shared platform and services.`,
    ``,
    `## 6. Ending the Agreement`,
    `Either party may end this Agreement with 30 days' written notice. Payments already due remain due${t.structure === 'equity' ? '; equity already granted stays granted' : ''}. LFG may stop work immediately if the Venture becomes unlawful or harmful.`,
    ``,
    `---`,
    `*Generated by LFG from the terms both parties agreed. It is not legal advice; either party may seek independent advice before signing.*`,
  ].join('\n');
}

const terms = (a: Agreement): DealTerms => ({ structure: a.structure, equityPercent: a.equityPercent, revenueSharePercent: a.revenueSharePercent, capMultiple: a.capMultiple, termMonths: a.termMonths });

async function draft(conversationId: string, decisionId: string, t: DealTerms, tokens: number) {
  const problem = dealTermsProblem(t);
  if (problem) throw new AgreementFailure('INVALID_TERMS', 400, problem);
  const [decision] = await db.select().from(ventureDecisions).where(eq(ventureDecisions.id, decisionId)).limit(1);
  const [assessment] = decision?.assessmentId ? await db.select().from(ventureAssessments).where(eq(ventureAssessments.id, decision.assessmentId)).limit(1) : [];
  const [row] = await db.select({ title: ventureConversations.title, name: users.name, email: users.email }).from(ventureConversations).innerJoin(users, eq(users.id, ventureConversations.userId)).where(eq(ventureConversations.id, conversationId)).limit(1);
  const r = (assessment?.contentJson as VentureAssessment | undefined)?.recommendation;
  const tasks = assessment ? await db.select().from(ventureTasks).where(eq(ventureTasks.assessmentId, assessment.id)).orderBy(asc(ventureTasks.position)) : [];
  const [last] = await db.select({ version: ventureAgreements.version }).from(ventureAgreements).where(eq(ventureAgreements.conversationId, conversationId)).orderBy(desc(ventureAgreements.version)).limit(1);
  const version = (last?.version ?? 0) + 1;
  // Only one open agreement at a time; signatures on older versions no longer count.
  await db.update(ventureAgreements).set({ status: 'superseded' }).where(and(eq(ventureAgreements.conversationId, conversationId), ne(ventureAgreements.status, 'active'), ne(ventureAgreements.status, 'superseded')));
  const body = agreementText({ version, founder: { name: row!.name, email: row!.email }, venture: row!.title, terms: t, tokens,
    lineItems: (r?.tokenTranche.lineItems ?? []).map(l => ({ item: l.item, deliverable: l.deliverable, tokens: Math.round(l.tokens * tokens / (r!.tokenTranche.totalTokens || 1)) })),
    commitments: tasks.map(x => ({ action: x.action, dueWeek: x.dueWeek })) });
  const [agreement] = await db.insert(ventureAgreements).values({ conversationId, decisionId, version, structure: t.structure, equityPercent: t.equityPercent, revenueSharePercent: t.revenueSharePercent, capMultiple: t.capMultiple, termMonths: t.termMonths, tokensCommitted: tokens, body }).returning();
  return agreement!;
}

export async function proposeAgreement(conversationId: string, decisionId: string, t: DealTerms, tokens: number) {
  const agreement = await draft(conversationId, decisionId, t, tokens);
  await recordEvent(conversationId, 'agreement', `Agreement v${agreement.version} ready to sign: ${DEAL_LABEL[t.structure]}`, termsSummary(t, tokens));
  return agreement;
}

async function load(id: string) {
  const [a] = await db.select().from(ventureAgreements).where(eq(ventureAgreements.id, id)).limit(1);
  if (!a) throw new AgreementFailure('AGREEMENT_NOT_FOUND', 404, 'This agreement is unavailable.');
  return a;
}
const touch = (conversationId: string) => db.update(ventureConversations).set({ updatedAt: new Date() }).where(eq(ventureConversations.id, conversationId));

export async function signAgreement(id: string, side: 'founder' | 'lfg', userId: string, signedName: string) {
  const a = await load(id);
  if (a.status !== 'awaiting_signatures') throw new AgreementFailure('NOT_SIGNABLE', 409, a.status === 'changes_requested' ? 'Changes were requested; LFG must respond before anyone signs.' : 'This version can no longer be signed.');
  if ((side === 'founder' ? a.founderSignedAt : a.lfgSignedAt)) throw new AgreementFailure('ALREADY_SIGNED', 409, 'This side has already signed.');
  const now = new Date();
  const patch = side === 'founder' ? { founderUserId: userId, founderSignedName: signedName, founderSignedAt: now } : { lfgUserId: userId, lfgSignedName: signedName, lfgSignedAt: now };
  await db.update(ventureAgreements).set(patch).where(eq(ventureAgreements.id, id));
  await recordEvent(a.conversationId, 'agreement', `${side === 'founder' ? 'Founder' : 'LFG'} signed agreement v${a.version}`, signedName);
  const signed = await load(id);
  if (signed.founderSignedAt && signed.lfgSignedAt) await activate(signed);
  await touch(a.conversationId);
  return load(id);
}

// Both signatures in: the tranche is released and LFG's agents start work.
async function activate(a: Agreement) {
  const now = new Date();
  await db.update(ventureAgreements).set({ status: 'active', activatedAt: now }).where(eq(ventureAgreements.id, a.id));
  const [decision] = a.decisionId ? await db.select().from(ventureDecisions).where(eq(ventureDecisions.id, a.decisionId)).limit(1) : [];
  const [assessment] = decision?.assessmentId ? await db.select().from(ventureAssessments).where(eq(ventureAssessments.id, decision.assessmentId)).limit(1) : [];
  const lines = (assessment?.contentJson as VentureAssessment | undefined)?.recommendation?.tokenTranche.lineItems ?? [];
  if (lines.length) {
    // Recommended proportions, scaled to exactly the committed amount.
    const total = lines.reduce((sum, l) => sum + l.tokens, 0) || 1;
    const budgets = lines.map(l => Math.floor(l.tokens * a.tokensCommitted / total));
    budgets[budgets.length - 1]! += a.tokensCommitted - budgets.reduce((x, y) => x + y, 0);
    await db.insert(ventureWorkItems).values(lines.map((l, i) => ({ conversationId: a.conversationId, decisionId: a.decisionId, workType: l.workType ?? 'product_feature', title: l.item, deliverable: l.deliverable ?? l.rationale, tokensBudgeted: budgets[i]! })));
  }
  await recordEvent(a.conversationId, 'agreement', `Agreement active: ${compact(a.tokensCommitted)} tokens released, work starts`, termsSummary(terms(a), a.tokensCommitted), a.tokensCommitted, now);
}

export async function requestChanges(id: string, userId: string, message: string, proposed?: Partial<DealTerms>) {
  const a = await load(id);
  if (a.status !== 'awaiting_signatures') throw new AgreementFailure('NOT_NEGOTIABLE', 409, a.status === 'changes_requested' ? 'A change request is already with LFG.' : 'This version is no longer open for changes.');
  await db.update(ventureAgreements).set({ status: 'changes_requested' }).where(eq(ventureAgreements.id, id));
  await db.insert(ventureAgreementMessages).values({ conversationId: a.conversationId, agreementId: id, authorUserId: userId, side: 'founder', kind: 'change_request', message, proposedTerms: proposed && Object.keys(proposed).length ? proposed : null });
  await recordEvent(a.conversationId, 'negotiation', `Founder asked to change agreement v${a.version}`, message);
  await touch(a.conversationId);
  return load(id);
}

// LFG's manual answer to a change request: new terms (a new version to sign),
// or the same terms with a reply, reopening this version for signatures.
export async function respondToChanges(id: string, userId: string, message: string, revised?: DealTerms & { tokens?: number }) {
  const a = await load(id);
  if (!['awaiting_signatures', 'changes_requested'].includes(a.status)) throw new AgreementFailure('NOT_NEGOTIABLE', 409, 'This version is no longer open.');
  if (revised) {
    const next = await draft(a.conversationId, a.decisionId!, revised, revised.tokens ?? a.tokensCommitted);
    await db.insert(ventureAgreementMessages).values({ conversationId: a.conversationId, agreementId: next.id, authorUserId: userId, side: 'lfg', kind: 'revision', message, proposedTerms: { ...revised } });
    await recordEvent(a.conversationId, 'negotiation', `LFG revised the terms: agreement v${next.version}`, `${termsSummary(revised, next.tokensCommitted)}. ${message}`);
    await touch(a.conversationId);
    return next;
  }
  await db.update(ventureAgreements).set({ status: 'awaiting_signatures' }).where(eq(ventureAgreements.id, id));
  await db.insert(ventureAgreementMessages).values({ conversationId: a.conversationId, agreementId: id, authorUserId: userId, side: 'lfg', kind: 'reply', message });
  await recordEvent(a.conversationId, 'negotiation', `LFG kept the terms of agreement v${a.version}`, message);
  await touch(a.conversationId);
  return load(id);
}

export async function agreementsFor(conversationId: string) {
  const agreements = await db.select().from(ventureAgreements).where(eq(ventureAgreements.conversationId, conversationId)).orderBy(desc(ventureAgreements.version));
  const messages = await db.select({ message: ventureAgreementMessages, author: users.name }).from(ventureAgreementMessages)
    .leftJoin(users, eq(users.id, ventureAgreementMessages.authorUserId)).where(eq(ventureAgreementMessages.conversationId, conversationId)).orderBy(asc(ventureAgreementMessages.createdAt));
  const current = agreements.find(a => a.status !== 'superseded' && a.status !== 'void') ?? null;
  return {
    current: current ? { ...current, summary: termsSummary(terms(current), current.tokensCommitted), valueUsd: tokenValueUsd(current.tokensCommitted) } : null,
    versions: agreements.map(a => ({ id: a.id, version: a.version, status: a.status, summary: termsSummary(terms(a), a.tokensCommitted), createdAt: a.createdAt })),
    messages: messages.map(m => ({ ...m.message, authorName: m.author })),
  };
}
