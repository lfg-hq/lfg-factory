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
export const assessmentSchema = z.object({
  status: z.enum(['provisional', 'ready']),
  missingInputs: z.array(text).max(30), assumptions: claims,
  founderFit: z.object({ rationale: claims, capabilityGaps: claims, distributionGaps: claims, recommendedChanges: claims }).strict(),
  opportunity: z.object({ customerPain: claims, competition: claims, opportunity: claims }).strict(),
  units: z.object({ currency: z.string().regex(/^[A-Z]{3}$/), period: z.enum(['month', 'year']), geography: text }).strict(),
  market: z.object({ tam: calculation, sam: calculation, som: calculation }).strict(),
  revenue: z.object({ conservative: calculation, base: calculation, upside: calculation }).strict(),
  financing: z.object({ venture: claims, bootstrapping: claims, profitSharing: claims }).strict(),
  gtm: z.object({ targetSegment: claims, channels: claims, experiments: z.array(z.object({ experiment: claim, suggestedBudget: z.number().finite().nonnegative().nullable(), budgetAssumptions: claims })).min(1).max(8) }).strict(),
  milestones: z.object({ validation: milestone(), mvp: milestone(), firstUser: milestone(), firstRevenue: milestone() }).strict(),
  uncertainties: claims,
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
  if (unknown && !value.missingInputs.length) throw new Error('MISSING_INPUTS_REQUIRED');
  if ((unknown || value.missingInputs.length) && value.status !== 'provisional') throw new Error('PROVISIONAL_REQUIRED');
  return value;
}
