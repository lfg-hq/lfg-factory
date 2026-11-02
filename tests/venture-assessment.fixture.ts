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
    milestones: { validation: milestone, mvp: milestone, firstUser: milestone, firstRevenue: milestone }, uncertainties: claims,
    recommendation: { verdict: 'needs_more_info', summary: 'TEST FIXTURE promising; willingness to pay unknown.', rationale: claims, tier: null, complianceFlags: [],
      tokenTranche: { totalTokens: 0, lineItems: [], expectedReturn: claim },
      founderCommitments: [{ action: 'TEST FIXTURE interview 10 plumbers in your network', successSignal: '3 commit to a paid pilot', dueWeek: 2 }, { action: 'TEST FIXTURE post 3 problem threads on X', successSignal: '20 replies', dueWeek: 1 }],
      nextSteps: ['TEST FIXTURE confirm willingness to pay, then reassess'], checkInWeeks: 2 } };
}

export function fundRecommendation(base = assessmentFixture()) {
  base.recommendation = { ...base.recommendation, verdict: 'fund', tier: 'micro',
    tokenTranche: { totalTokens: 2_500_000, lineItems: [{ workType: 'landing_page', item: 'TEST FIXTURE landing page', deliverable: 'TEST FIXTURE page collecting pilot sign-ups', tokens: 500_000, rationale: 'Collect pilot sign-ups' }, { workType: 'mvp', item: 'TEST FIXTURE scheduling MVP', deliverable: 'TEST FIXTURE booking flow plumbers can use', tokens: 2_000_000, rationale: 'Pilot with 10 plumbers' }], expectedReturn: base.recommendation.rationale[0] } } as any;
  return base;
}
