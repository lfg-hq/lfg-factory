// TEST FIXTURE ONLY — not live provider or market evidence.
export function assessmentFixture(sourceId?: string) {
  const claim = { text: 'TEST FIXTURE assumption; validate with customer interviews.', kind: sourceId ? 'sourced' : 'estimate', sourceIds: sourceId ? [sourceId] : [] };
  const claims = [claim];
  const calc = (customers: number) => ({ rationale: claim, customers, pricePerCustomer: 10, amount: customers * 10, formula: 'customers * pricePerCustomer', assumptions: claims });
  const milestone = { plan: claim, earliestWeek: 1, latestWeek: 4, dependencies: ['TEST FIXTURE customer interviews'] };
  return { status: 'provisional', missingInputs: ['TEST FIXTURE actual willingness to pay'], assumptions: claims,
    founderFit: { rationale: claims, capabilityGaps: claims, distributionGaps: claims, recommendedChanges: claims },
    opportunity: { customerPain: claims, competition: claims, opportunity: claims },
    units: { currency: 'USD', period: 'year', geography: 'TEST FIXTURE US only' },
    market: { tam: calc(1000), sam: calc(100), som: calc(10) }, revenue: { conservative: calc(1), base: calc(2), upside: calc(3) },
    financing: { venture: claims, bootstrapping: claims, profitSharing: claims },
    gtm: { targetSegment: claims, channels: claims, experiments: [{ experiment: claim, suggestedBudget: null, budgetAssumptions: claims }] },
    milestones: { validation: milestone, mvp: milestone, firstUser: milestone, firstRevenue: milestone }, uncertainties: claims };
}
