import { z } from 'zod';

const text = z.string().trim().min(1).max(2400);
const claim = z.object({ text, kind: z.enum(['sourced', 'self-report', 'estimate', 'unknown', 'contradicted']), sourceIds: z.array(z.string().uuid()).max(20) }).strict();
const claims = z.array(claim).min(1).max(12);
// All monetary calculations use customers × price/customer/period. No executable formulas.
const calculation = z.object({
  rationale: claim, customers: z.number().finite().nonnegative().nullable(),
  pricePerCustomer: z.number().finite().nonnegative().nullable(),
  amount: z.number().finite().nonnegative().nullable(),
  formula: z.literal('customers * pricePerCustomer'), assumptions: claims,
}).strict();
// First-tranche sizing guide shared by the prompt and validation. Tokens are what
// LFG's agents spend building and running the venture, not cash to the founder.
export const TOKEN_POLICY = {
  maxFirstTranche: 500_000_000,
  guide: [
    'Landing page + content/distribution strategy: 100K–1M tokens',
    'Small internal tool or no-code-backed MVP: 1M–5M tokens',
    'Production SaaS MVP with auth, payments and integrations: 5M–50M tokens',
    'Complex platform (e.g. observability, data infrastructure): 50M–500M tokens, staged',
  ],
} as const;
// What LFG's agents can spend tokens on. Shared by the assessment, the work
// items created on approval, and the dashboard labels.
export const WORK_TYPES = ['landing_page', 'content_strategy', 'mvp', 'product_feature', 'integration', 'support_tooling', 'security', 'maintenance', 'marketing', 'sales', 'analytics', 'operations'] as const;
export type WorkType = typeof WORK_TYPES[number];
// How LFG is paid back for a tranche: a stake in the company, or a share of
// revenue or profit until a capped multiple of the tokens' value is returned.
export const DEAL_STRUCTURES = ['equity', 'revenue_share', 'profit_share'] as const;
export type DealStructure = typeof DEAL_STRUCTURES[number];
export interface DealTerms { structure: DealStructure; equityPercent: number | null; revenueSharePercent: number | null; capMultiple: number | null; termMonths: number | null }
// Terms are either a stake, or a share with a cap and a term, never both.
export function dealTermsProblem(d: DealTerms) {
  if (d.structure === 'equity') return d.equityPercent === null ? 'Equity deals need a stake.' : d.revenueSharePercent !== null || d.capMultiple !== null ? 'Equity deals carry no revenue share or cap.' : null;
  return d.revenueSharePercent === null || d.capMultiple === null || d.termMonths === null ? 'Share deals need a percentage, a cap multiple and a term.' : d.equityPercent !== null ? 'Share deals carry no equity.' : null;
}
const tokens = z.number().int().nonnegative().max(TOKEN_POLICY.maxFirstTranche);
const recommendation = z.object({
  verdict: z.enum(['fund', 'needs_more_info', 'decline', 'prohibited']),
  summary: text,
  rationale: claims,
  tier: z.enum(['micro', 'small_business', 'venture_scale']).nullable(),
  complianceFlags: z.array(claim).max(8),
  tokenTranche: z.object({
    totalTokens: tokens,
    lineItems: z.array(z.object({ workType: z.enum(WORK_TYPES), item: text, deliverable: text, tokens: tokens, rationale: text }).strict()).max(12),
    expectedReturn: claim,
  }).strict(),
  founderCommitments: z.array(z.object({ action: text, successSignal: text, dueWeek: z.number().int().nonnegative().nullable() }).strict()).max(10),
  nextSteps: z.array(text).min(1).max(8),
  checkInWeeks: z.number().int().min(1).max(12).nullable(),
  // How LFG is paid back. Required for "fund"; null otherwise.
  deal: z.object({
    structure: z.enum(DEAL_STRUCTURES),
    equityPercent: z.number().min(0.1).max(49).nullable(),
    revenueSharePercent: z.number().min(0.5).max(50).nullable(),
    capMultiple: z.number().min(1).max(10).nullable(),
    termMonths: z.number().int().min(6).max(120).nullable(),
    rationale: text,
  }).strict().nullable(),
}).strict();
export const assessmentSchema = z.object({
  status: z.enum(['provisional', 'ready']),
  missingInputs: z.array(text).max(30), assumptions: claims,
  founderFit: z.object({ rationale: claims, capabilityGaps: claims, distributionGaps: claims, recommendedChanges: claims }).strict(),
  opportunity: z.object({ customerPain: claims, competition: claims, opportunity: claims }).strict(),
  // LFG reports every figure in US dollars; local prices are converted in assumptions.
  units: z.object({ currency: z.literal('USD'), period: z.enum(['month', 'year']), geography: text }).strict(),
  market: z.object({ tam: calculation, sam: calculation, som: calculation }).strict(),
  revenue: z.object({ conservative: calculation, base: calculation, upside: calculation }).strict(),
  financing: z.object({ venture: claims, bootstrapping: claims, profitSharing: claims }).strict(),
  gtm: z.object({ targetSegment: claims, channels: claims, experiments: z.array(z.object({ experiment: claim, suggestedBudget: z.number().finite().nonnegative().nullable(), budgetAssumptions: claims })).min(1).max(8) }).strict(),
  milestones: z.object({ validation: milestone(), mvp: milestone(), firstUser: milestone(), firstRevenue: milestone() }).strict(),
  uncertainties: claims,
  recommendation,
}).strict();
function milestone() { return z.object({ plan: claim, earliestWeek: z.number().int().nonnegative().nullable(), latestWeek: z.number().int().nonnegative().nullable(), dependencies: z.array(text).min(1).max(10) }).strict(); }
export type VentureAssessment = z.infer<typeof assessmentSchema>;
export function validateAssessment(input: unknown, sourceIds: Set<string>): VentureAssessment {
  const value = assessmentSchema.parse(input);
  let unknown = false;
  function walk(node: any) {
    if (!node || typeof node !== 'object') return;
    if (node.kind) {
      if (node.sourceIds.some((id: string) => !sourceIds.has(id))) throw new Error('INVALID_CITATION');
      if (['sourced', 'contradicted'].includes(node.kind) && !node.sourceIds.length) throw new Error('MISSING_CITATION');
      if (node.kind === 'unknown') unknown = true;
    }
    if ('suggestedBudget' in node && node.suggestedBudget === null) unknown = true;
    if ('earliestWeek' in node) {
      if ((node.earliestWeek === null) !== (node.latestWeek === null) || (node.earliestWeek !== null && node.earliestWeek > node.latestWeek)) throw new Error('INVALID_TIMELINE');
      if (node.earliestWeek === null) unknown = true;
    }
    Object.values(node).forEach(walk);
  }
  walk(value);
  for (const c of [...Object.values(value.market), ...Object.values(value.revenue)]) {
    if (c.customers === null || c.pricePerCustomer === null) {
      unknown = true;
      if (c.amount !== null) throw new Error('MISSING_NUMERIC_INPUT');
    } else {
      const expected = c.customers * c.pricePerCustomer;
      if (!Number.isFinite(expected) || c.amount === null || Math.abs(c.amount - expected) > Math.max(0.005, expected * 1e-9)) throw new Error('INVALID_ARITHMETIC');
    }
  }
  const { tam, sam, som } = value.market;
  if ((tam.amount !== null && sam.amount !== null && sam.amount > tam.amount) || (sam.amount !== null && som.amount !== null && som.amount > sam.amount)) throw new Error('INVALID_MARKET_ORDER');
  const { conservative, base, upside } = value.revenue;
  if ((conservative.amount !== null && base.amount !== null && conservative.amount > base.amount) || (base.amount !== null && upside.amount !== null && base.amount > upside.amount)) throw new Error('INVALID_SCENARIO_ORDER');
  const r = value.recommendation, tranche = r.tokenTranche;
  if (tranche.lineItems.reduce((sum, item) => sum + item.tokens, 0) !== tranche.totalTokens) throw new Error('INVALID_TOKEN_SUM');
  if (r.verdict === 'fund' && (tranche.totalTokens <= 0 || !r.tier || !r.founderCommitments.length)) throw new Error('INVALID_FUND_RECOMMENDATION');
  if (r.verdict !== 'fund' && tranche.totalTokens !== 0) throw new Error('TOKENS_WITHOUT_FUNDING');
  if (r.verdict === 'prohibited' && !r.complianceFlags.length) throw new Error('MISSING_COMPLIANCE_FLAGS');
  if (r.verdict === 'fund' && !r.deal) throw new Error('MISSING_DEAL_TERMS');
  if (r.verdict !== 'fund' && r.deal) throw new Error('DEAL_WITHOUT_FUNDING');
  if (r.deal && dealTermsProblem(r.deal)) throw new Error('INVALID_DEAL_TERMS');
  if (r.verdict === 'needs_more_info' && !value.missingInputs.length) throw new Error('MISSING_INPUTS_REQUIRED');
  if (unknown && !value.missingInputs.length) throw new Error('MISSING_INPUTS_REQUIRED');
  if ((unknown || value.missingInputs.length) && value.status !== 'provisional') throw new Error('PROVISIONAL_REQUIRED');
  return value;
}
