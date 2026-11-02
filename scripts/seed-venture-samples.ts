// SAMPLE DATA for local development only: fills the venture dashboard with
// realistic ventures across every verdict. Everything it creates has an id
// starting with "sample-", so it can be removed cleanly.
//
//   bun run scripts/seed-venture-samples.ts <owner-email>        # (re)seed
//   bun run scripts/seed-venture-samples.ts <owner-email> --clean  # remove
//
// The owner email is your Google-linked account; it owns three ventures and
// records the sample LFG decisions. Other founders are sample users.
import { eq, like } from 'drizzle-orm';
import { db } from '../src/config/db.ts';
import { users } from '../src/db/schema/users.ts';
import { ventureConversations, ventureMessages, ventureSources, ventureAssessments, ventureDecisions, ventureTasks } from '../src/venture/db/schema.ts';
import { validateAssessment } from '../src/venture/services/assessment.ts';
import { saveTasks } from '../src/venture/services/dashboard.ts';

if (process.env.NODE_ENV === 'production') throw new Error('Sample data is for local development only.');
const [ownerEmail, flag] = process.argv.slice(2);
if (!ownerEmail) throw new Error('Usage: bun run scripts/seed-venture-samples.ts <owner-email> [--clean]');
const [owner] = await db.select().from(users).where(eq(users.email, ownerEmail)).limit(1);
if (!owner) throw new Error(`No user with email ${ownerEmail}. Sign in with Google once first.`);

await db.delete(ventureConversations).where(like(ventureConversations.id, 'sample-%'));
await db.delete(users).where(like(users.id, 'sample-user-%'));
if (flag === '--clean') { console.log('Removed venture sample data.'); process.exit(0); }

// ---- builders -------------------------------------------------------------
type Kind = 'sourced' | 'self-report' | 'estimate' | 'unknown' | 'contradicted';
const c = (text: string, kind: Kind = 'estimate', sourceIds: string[] = []) => ({ text, kind, sourceIds });
const calc = (customers: number | null, price: number | null, why: string, assumption: string, kind: Kind = 'estimate', sources: string[] = []) => ({
  rationale: c(why, kind, sources), customers, pricePerCustomer: price,
  amount: customers === null || price === null ? null : customers * price,
  formula: 'customers * pricePerCustomer' as const, assumptions: [c(assumption)],
});
const milestone = (plan: string, earliest: number | null, latest: number | null, deps: string[]) => ({ plan: c(plan), earliestWeek: earliest, latestWeek: latest, dependencies: deps });
const day = (n: number) => new Date(Date.now() - n * 86_400_000);

interface Sample {
  id: string; title: string; founder: { name: string; email: string } | null; daysAgo: number;
  sources?: { url: string; title: string; excerpt: string }[];
  messages: [role: 'user' | 'assistant', content: string][];
  assessment?: (src: string[]) => unknown;
  done?: number[];
  decision?: { decision: 'approved' | 'needs_more_info' | 'declined' | 'prohibited'; tokensApproved: number; founderNote?: string; internalNote?: string };
}

const samples: Sample[] = [
  {
    id: 'sample-plumber', title: 'Job scheduling app for independent plumbers', founder: null, daysAgo: 1,
    sources: [
      { url: 'https://www.bls.gov/ooh/construction-and-extraction/plumbers-pipefitters-and-steamfitters.htm', title: 'Plumbers, Pipefitters, and Steamfitters — BLS', excerpt: '[Sample data] Employment of plumbers is projected to grow; many work as independent contractors.' },
      { url: 'https://www.servicetitan.com/pricing', title: 'ServiceTitan pricing', excerpt: '[Sample data] Enterprise field-service platform priced for multi-truck companies.' },
    ],
    messages: [
      ['user', 'I run a 3-person plumbing business in Pune and lose 5–6 jobs a week because I can’t answer the phone while on site. I want a simple scheduling + WhatsApp booking tool for plumbers like me.'],
      ['assistant', 'That’s a sharp, lived problem. A few questions to size it:\n\n- **How many independent plumbers** do you personally know who have the same issue?\n- What do they use today — WhatsApp, a diary, nothing?\n- Would they pay **$12/month** if it recovered even 2 jobs a month?'],
      ['user', 'I’m in 3 WhatsApp groups with ~400 plumbers. Most use WhatsApp and a paper diary. Two friends said they’d pay if it books jobs while they’re working.'],
      ['assistant', '## Early read\n\nThis looks like a **micro business with a fast path to revenue**:\n\n| Signal | Read |\n|---|---|\n| Pain | Missed calls = lost jobs, frequent and costly |\n| Distribution | 400 plumbers reachable in your groups |\n| Competition | Enterprise tools (ServiceTitan) are priced for fleets |\n\nNext: interview 10 plumbers this week and ask for a paid pilot. Then generate the assessment.'],
    ],
    assessment: ([bls, st]) => ({
      status: 'ready', missingInputs: [],
      assumptions: [c('Independent plumbers lose 3–6 bookings a week to missed calls.', 'self-report')],
      founderFit: {
        rationale: [c('Founder is a working plumber with direct access to ~400 peers.', 'self-report')],
        capabilityGaps: [c('No product or software background; LFG agents cover build and hosting.')],
        distributionGaps: [c('Reach is limited to Pune WhatsApp groups initially.')],
        recommendedChanges: [c('Recruit 2 plumber champions in another city before month 3.')],
      },
      opportunity: {
        customerPain: [c('Missed calls while on site translate directly into lost jobs.', 'self-report')],
        competition: [c('Field-service suites target multi-truck firms and are priced accordingly.', 'sourced', [st!])],
        opportunity: [c('A WhatsApp-first booking assistant fits how solo tradespeople already work.')],
      },
      units: { currency: 'USD', period: 'year', geography: 'India, independent plumbers in tier-1 and tier-2 cities' },
      market: {
        tam: calc(600_000, 144, 'Independent plumbers across India.', 'Assumes 600K independent plumbers.', 'sourced', [bls!]),
        sam: calc(120_000, 144, 'Plumbers in tier-1/2 cities using WhatsApp for work.', 'About 20% of TAM.'),
        som: calc(2_400, 144, 'Reachable in 24 months via groups and referrals.', '2% of SAM.'),
      },
      revenue: {
        conservative: calc(150, 144, 'Pune groups only, year one.', '150 paying plumbers.'),
        base: calc(400, 144, 'Pune plus one more city.', '400 paying plumbers.'),
        upside: calc(1_000, 144, 'Referral loop across three cities.', '1,000 paying plumbers.'),
      },
      financing: {
        venture: [c('Not venture-scale; profit-share suits a cash-generating niche.')],
        bootstrapping: [c('Founder can self-fund pilots but not engineering.')],
        profitSharing: [c('Best fit: LFG builds and runs it for a share of profit.')],
      },
      gtm: {
        targetSegment: [c('Solo and 2–5 person plumbing businesses in Pune.')],
        channels: [c('Plumber WhatsApp groups, supplier counters, referral credits.')],
        experiments: [
          { experiment: c('Paid pilot with 10 plumbers from the founder’s groups.'), suggestedBudget: 180, budgetAssumptions: [c('$18 onboarding support per plumber.')] },
          { experiment: c('Poster + QR code at 5 plumbing supply shops.'), suggestedBudget: 100, budgetAssumptions: [c('Printing and shop incentives.')] },
        ],
      },
      milestones: {
        validation: milestone('10 interviews, 3 paid pilot commitments.', 1, 2, ['Founder interviews']),
        mvp: milestone('WhatsApp booking + calendar MVP live.', 3, 5, ['First tranche approved']),
        firstUser: milestone('First plumber books a job through the app.', 5, 6, ['MVP live']),
        firstRevenue: milestone('First $12 subscription paid.', 6, 8, ['Pilot converts']),
      },
      uncertainties: [c('Plumbers may churn after the pilot if bookings don’t increase.')],
      recommendation: {
        verdict: 'fund', summary: 'Real, frequent pain, a founder inside the market and 400 reachable customers. Fund an MVP and a 10-plumber paid pilot.',
        rationale: [c('Founder-market fit is unusually strong.', 'self-report'), c('Payback is plausible within the first 50 subscribers.')],
        tier: 'micro', complianceFlags: [],
        tokenTranche: {
          totalTokens: 3_200_000,
          lineItems: [
            { item: 'WhatsApp booking assistant + scheduling MVP', tokens: 2_200_000, rationale: 'Core product on LFG’s shared auth, payments and messaging.' },
            { item: 'Landing page and onboarding flow', tokens: 500_000, rationale: 'Pilot sign-ups and payment collection.' },
            { item: 'Support playbook and FAQ bot', tokens: 500_000, rationale: 'Keep the founder on site, not on support.' },
          ],
          expectedReturn: c('~3.2M tokens against ~$58K/yr base-case revenue; break-even at roughly 40 subscribers.'),
        },
        founderCommitments: [
          { action: 'Interview 10 plumbers from your WhatsApp groups', successSignal: 'Notes on how each handles missed calls', dueWeek: 1 },
          { action: 'Get 3 plumbers to commit to a paid pilot', successSignal: '3 deposits of $6', dueWeek: 2 },
          { action: 'Post a 60-second demo video in your groups', successSignal: '25 replies or DMs', dueWeek: 4 },
          { action: 'Log what worked and what didn’t after each pilot week', successSignal: 'Weekly notes shared with the analyst', dueWeek: 6 },
        ],
        nextSteps: ['LFG reviews and releases the first tranche', 'Agents build the MVP while you run interviews', 'Check-in after the pilot cohort’s first two weeks'],
        checkInWeeks: 2,
      },
    }),
    done: [0, 1],
    decision: { decision: 'approved', tokensApproved: 3_000_000, founderNote: 'Approved. We trimmed the support bot; start with the booking flow and pilot.', internalNote: 'Strong founder-market fit. Revisit tranche 2 after pilot retention.' },
  },
  {
    id: 'sample-observability', title: 'Open-source AI observability platform', founder: null, daysAgo: 3,
    sources: [{ url: 'https://www.datadoghq.com/pricing/', title: 'Datadog pricing', excerpt: '[Sample data] Per-host and per-GB pricing; costs grow quickly with log volume.' }],
    messages: [
      ['user', 'I spent 8 years as an SRE at a large fintech. Datadog bills are crushing mid-size companies. I want an AI-first, open-core observability platform that auto-triages incidents.'],
      ['assistant', 'Big market, heavy competition. To size the first tranche:\n\n1. Which **20 companies** in your network would trial it?\n2. What’s the smallest wedge: logs, traces, or **incident triage**?\n3. Can you commit full time for 12 months?'],
    ],
    assessment: ([dd]) => ({
      status: 'provisional', missingInputs: ['Number of design partners willing to send production telemetry'],
      assumptions: [c('Mid-market teams spend $150K–$1M a year on observability.', 'estimate')],
      founderFit: {
        rationale: [c('Eight years of SRE experience at scale; credible with buyers.', 'self-report')],
        capabilityGaps: [c('No go-to-market or enterprise sales experience.')],
        distributionGaps: [c('Network is strong in fintech, thin elsewhere.')],
        recommendedChanges: [c('Recruit a GTM co-founder before tranche 2.')],
      },
      opportunity: {
        customerPain: [c('Observability bills scale faster than revenue for data-heavy teams.', 'sourced', [dd!])],
        competition: [c('Datadog, Grafana, Honeycomb and several open-source stacks.')],
        opportunity: [c('AI incident triage is an underserved wedge on top of open telemetry.')],
      },
      units: { currency: 'USD', period: 'year', geography: 'North America and Europe, mid-market SaaS' },
      market: {
        tam: calc(40_000, 250_000, 'Mid-market companies with real observability spend.', 'Average $250K/yr spend.'),
        sam: calc(8_000, 250_000, 'Cloud-native teams open to open-core tools.', '20% of TAM.'),
        som: calc(80, 60_000, 'Design partners converting at a discount.', '1% of SAM at $60K ACV.'),
      },
      revenue: {
        conservative: calc(10, 40_000, 'Design partners only.', '10 customers at $40K.'),
        base: calc(30, 60_000, 'Partners plus referrals.', '30 customers at $60K.'),
        upside: calc(80, 80_000, 'Open-source adoption converts.', '80 customers at $80K.'),
      },
      financing: {
        venture: [c('Venture-scale outcome possible; capital-intensive to compete.')],
        bootstrapping: [c('Not realistic given infrastructure costs.')],
        profitSharing: [c('Equity better aligned than profit-share for this tier.')],
      },
      gtm: {
        targetSegment: [c('Platform teams at 200–2,000 person SaaS companies.')],
        channels: [c('Open-source launch, SRE communities, founder network.')],
        experiments: [{ experiment: c('Recruit 5 design partners for a 6-week incident-triage trial.'), suggestedBudget: null, budgetAssumptions: [c('Cost depends on partner data volumes.', 'unknown')] }],
      },
      milestones: {
        validation: milestone('5 signed design partners.', 2, 6, ['Founder network outreach']),
        mvp: milestone('Triage agent on OpenTelemetry data.', 8, 14, ['Tranche approved', 'Partner data access']),
        firstUser: milestone('First partner triages a live incident with it.', 12, 16, ['MVP']),
        firstRevenue: milestone('First paid conversion.', null, null, ['Partner budgets']),
      },
      uncertainties: [c('Whether partners will route production data to a new vendor.', 'unknown')],
      recommendation: {
        verdict: 'fund', summary: 'Credible founder in a huge market. Fund a staged first tranche for the triage wedge, gated on design partners.',
        rationale: [c('Large, painful spend with a clear AI wedge.'), c('Founder brings deep domain credibility.', 'self-report')],
        tier: 'venture_scale', complianceFlags: [],
        tokenTranche: {
          totalTokens: 180_000_000,
          lineItems: [
            { item: 'OpenTelemetry ingest and storage on LFG’s shared infrastructure', tokens: 70_000_000, rationale: 'Minimum viable pipeline for partner data.' },
            { item: 'AI incident-triage agent', tokens: 80_000_000, rationale: 'The differentiating wedge.' },
            { item: 'Open-source launch site, docs and community', tokens: 30_000_000, rationale: 'Top-of-funnel for design partners.' },
          ],
          expectedReturn: c('180M tokens is justified only if 5 partners convert near $60K ACV; staged release reduces risk.'),
        },
        founderCommitments: [
          { action: 'Sign 5 design partners from your network', successSignal: '5 signed trial letters', dueWeek: 4 },
          { action: 'Run 3 incident post-mortem interviews per partner', successSignal: '15 documented incidents', dueWeek: 6 },
          { action: 'Publish one technical post a week on X and LinkedIn', successSignal: '500 waitlist sign-ups', dueWeek: 8 },
        ],
        nextSteps: ['LFG review with infrastructure cost check', 'Release tranche in two stages', 'Check-in when 3 partners are signed'],
        checkInWeeks: 4,
      },
    }),
    done: [0],
  },
  {
    id: 'sample-email', title: 'Email automation for newsletter creators', founder: null, daysAgo: 6,
    messages: [
      ['user', 'Newsletter creators waste hours segmenting and sending follow-ups. I want an AI email automation tool for them.'],
      ['assistant', 'Plausible, but crowded. **Who exactly** is the customer, how many do you know, and what do they pay for tools today?'],
    ],
    assessment: () => ({
      status: 'provisional', missingInputs: ['Specific creator segment and list size', 'Current tool spend of 10 target creators', 'Founder’s own distribution on X'],
      assumptions: [c('Creators with 5K–50K subscribers pay for automation.', 'unknown')],
      founderFit: {
        rationale: [c('Founder writes a 3K-subscriber newsletter.', 'self-report')],
        capabilityGaps: [c('No marketing automation experience.')],
        distributionGaps: [c('Small audience; no creator partnerships yet.')],
        recommendedChanges: [c('Pick one niche (e.g. finance newsletters) before building.')],
      },
      opportunity: {
        customerPain: [c('Manual segmentation and follow-ups take hours a week.', 'self-report')],
        competition: [c('Beehiiv, ConvertKit and Mailchimp already automate much of this.')],
        opportunity: [c('Unclear wedge beyond what incumbents offer.', 'unknown')],
      },
      units: { currency: 'USD', period: 'month', geography: 'Global, English-language newsletters' },
      market: {
        tam: calc(null, 29, 'Number of paying creators unknown.', 'Needs a segment count.'),
        sam: calc(null, 29, 'Depends on chosen niche.', 'Needs niche choice.'),
        som: calc(null, 29, 'Depends on founder distribution.', 'Unknown reach.'),
      },
      revenue: {
        conservative: calc(null, 29, 'Unknown customers.', 'Pending interviews.'),
        base: calc(null, 29, 'Unknown customers.', 'Pending interviews.'),
        upside: calc(null, 29, 'Unknown customers.', 'Pending interviews.'),
      },
      financing: {
        venture: [c('Not venture-scale as framed.')],
        bootstrapping: [c('Feasible with a landing page and content-led growth.')],
        profitSharing: [c('Possible once a niche shows pull.')],
      },
      gtm: {
        targetSegment: [c('To be decided after interviews.', 'unknown')],
        channels: [c('X threads, creator communities.')],
        experiments: [{ experiment: c('Landing page + waitlist for one niche.'), suggestedBudget: 200, budgetAssumptions: [c('Domain and small ad test.')] }],
      },
      milestones: {
        validation: milestone('Interview 10 creators in one niche.', 1, 3, ['Niche choice']),
        mvp: milestone('Not yet.', null, null, ['Validation']),
        firstUser: milestone('Not yet.', null, null, ['MVP']),
        firstRevenue: milestone('Not yet.', null, null, ['First users']),
      },
      uncertainties: [c('Whether any wedge beats incumbent features.', 'unknown')],
      recommendation: {
        verdict: 'needs_more_info', summary: 'Crowded space and no defined niche yet. Validate one creator segment, then come back for a landing-page tranche.',
        rationale: [c('Incumbents cover the core workflow.'), c('Customer and willingness to pay are unknown.', 'unknown')],
        tier: null, complianceFlags: [],
        tokenTranche: { totalTokens: 0, lineItems: [], expectedReturn: c('No spend until a niche shows pull; a ~300K-token landing page would follow.') },
        founderCommitments: [
          { action: 'Choose one creator niche and list 20 creators in it', successSignal: 'Named list shared with the analyst', dueWeek: 1 },
          { action: 'Interview 10 of them about their weekly email workflow', successSignal: '3 describe a painful, paid-for gap', dueWeek: 3 },
        ],
        nextSteps: ['Run interviews', 'Return to chat with findings', 'Regenerate the assessment'],
        checkInWeeks: 3,
      },
    }),
    decision: { decision: 'needs_more_info', tokensApproved: 0, founderNote: 'Agree with the analyst. Pick a niche and bring us 10 interviews.' },
  },
  {
    id: 'sample-bookkeeping', title: 'Bookkeeping copilot for D2C brands', founder: { name: 'Priya Raman', email: 'priya@sample.lfg.local' }, daysAgo: 2,
    messages: [['user', 'I’m a CA who does books for 35 D2C brands on Shopify. Reconciliation of marketplace payouts takes my team 60 hours a month.']],
    assessment: () => ({
      status: 'ready', missingInputs: [],
      assumptions: [c('D2C brands on Shopify and marketplaces reconcile payouts manually.', 'self-report')],
      founderFit: {
        rationale: [c('Chartered accountant serving 35 target customers today.', 'self-report')],
        capabilityGaps: [c('No product team; LFG agents build.')],
        distributionGaps: [c('Beyond her clients, reach is via CA networks.')],
        recommendedChanges: [c('Sign 5 existing clients as paid design partners.')],
      },
      opportunity: {
        customerPain: [c('Payout reconciliation takes ~60 hours a month for 35 brands.', 'self-report')],
        competition: [c('Generic accounting tools lack marketplace payout matching.')],
        opportunity: [c('A copilot sold through CAs reaches brands at low CAC.')],
      },
      units: { currency: 'USD', period: 'year', geography: 'India, D2C brands selling on Shopify and marketplaces' },
      market: {
        tam: calc(80_000, 720, 'Indian D2C brands with marketplace revenue.', '$60/month ($720/yr).'),
        sam: calc(15_000, 720, 'Brands using an external CA.', 'About 19% of TAM.'),
        som: calc(600, 720, 'Reachable via 20 partner CAs in 2 years.', '4% of SAM.'),
      },
      revenue: {
        conservative: calc(35, 720, 'Existing clients only.', 'All 35 convert.'),
        base: calc(150, 720, 'Plus 5 partner CAs.', '150 brands.'),
        upside: calc(400, 720, 'CA channel scales.', '400 brands.'),
      },
      financing: {
        venture: [c('Could become venture-scale through the CA channel; early to tell.')],
        bootstrapping: [c('Her practice can fund pilots.')],
        profitSharing: [c('Good fit: cash-generating from month one.')],
      },
      gtm: {
        targetSegment: [c('D2C brands doing $120K–$2.4M a year on Shopify plus marketplaces.')],
        channels: [c('Her own clients, then partner CA firms.')],
        experiments: [{ experiment: c('Pilot with 5 clients for one month-end close.'), suggestedBudget: 0, budgetAssumptions: [c('Existing relationships; no spend.')] }],
      },
      milestones: {
        validation: milestone('5 clients agree to pay for the pilot.', 1, 2, ['Client conversations']),
        mvp: milestone('Shopify + Amazon payout reconciliation live.', 3, 6, ['Tranche approved']),
        firstUser: milestone('First month-end closed with the copilot.', 6, 8, ['MVP']),
        firstRevenue: milestone('First paid month.', 7, 9, ['Pilot success']),
      },
      uncertainties: [c('Marketplace API access may limit automation depth.')],
      recommendation: {
        verdict: 'fund', summary: 'Founder already serves the customer and feels the pain weekly. Fund reconciliation MVP for her 35 clients.',
        rationale: [c('Day-one customers and a low-CAC channel.')],
        tier: 'small_business', complianceFlags: [],
        tokenTranche: {
          totalTokens: 12_000_000,
          lineItems: [
            { item: 'Payout ingestion for Shopify, Amazon, Flipkart', tokens: 6_000_000, rationale: 'Core data plumbing.' },
            { item: 'Reconciliation copilot and review UI', tokens: 5_000_000, rationale: 'Saves the 60 hours.' },
            { item: 'Partner-CA onboarding site', tokens: 1_000_000, rationale: 'Second channel.' },
          ],
          expectedReturn: c('12M tokens vs ~$108K/yr base case; payback within the first client cohort.'),
        },
        founderCommitments: [
          { action: 'Sign 5 clients to a paid pilot', successSignal: '5 signed pilot agreements', dueWeek: 2 },
          { action: 'Introduce the copilot to 3 partner CA firms', successSignal: '1 firm agrees to resell', dueWeek: 8 },
        ],
        nextSteps: ['Approve tranche', 'Build ingestion first', 'Close one month-end with 5 clients'],
        checkInWeeks: 4,
      },
    }),
    done: [0],
    decision: { decision: 'approved', tokensApproved: 10_000_000, founderNote: 'Approved at 10M; partner-CA site comes with tranche 2.' },
  },
  {
    id: 'sample-petsitting', title: 'Pet-sitting marketplace in Austin', founder: { name: 'Marcus Lee', email: 'marcus@sample.lfg.local' }, daysAgo: 9,
    messages: [['user', 'I want to build Rover but local to Austin, with lower fees.']],
    assessment: () => ({
      status: 'provisional', missingInputs: ['Any supply-side commitments from sitters'],
      assumptions: [c('Owners would switch for lower fees.', 'unknown')],
      founderFit: {
        rationale: [c('Founder is a pet owner; no marketplace or local-ops experience.', 'self-report')],
        capabilityGaps: [c('No operations or trust-and-safety experience.')],
        distributionGaps: [c('No sitter or owner community access.')],
        recommendedChanges: [c('Partner with an existing sitter collective before building.')],
      },
      opportunity: {
        customerPain: [c('Fees on incumbents are high but service is reliable.')],
        competition: [c('Rover and Wag dominate with insurance and reviews.')],
        opportunity: [c('Lower fees alone are a weak wedge against network effects.')],
      },
      units: { currency: 'USD', period: 'year', geography: 'Austin, Texas' },
      market: {
        tam: calc(300_000, 120, 'Dog-owning households in Austin.', '$120/yr take per household.'),
        sam: calc(60_000, 120, 'Households using paid sitters.', '20% of TAM.'),
        som: calc(600, 120, 'Plausible share against incumbents.', '1% of SAM.'),
      },
      revenue: {
        conservative: calc(100, 120, 'Friends and neighbours.', '100 households.'),
        base: calc(300, 120, 'Local marketing.', '300 households.'),
        upside: calc(600, 120, 'Strong word of mouth.', '600 households.'),
      },
      financing: {
        venture: [c('Not venture-scale as a single-city clone.')],
        bootstrapping: [c('Possible as a side business with a sitter collective.')],
        profitSharing: [c('Upside too small to justify LFG’s build and operations cost.')],
      },
      gtm: {
        targetSegment: [c('Austin dog owners in two neighbourhoods.')],
        channels: [c('Dog parks, vets, Nextdoor.')],
        experiments: [{ experiment: c('Manual matching via a form for 20 bookings.'), suggestedBudget: 300, budgetAssumptions: [c('Flyers and a form tool.')] }],
      },
      milestones: {
        validation: milestone('20 bookings matched manually.', 2, 6, ['Sitter supply']),
        mvp: milestone('Not recommended yet.', null, null, ['Validation']),
        firstUser: milestone('Manual first booking.', 1, 3, ['Sitter partner']),
        firstRevenue: milestone('First paid booking.', 2, 4, ['Sitter partner']),
      },
      uncertainties: [c('Trust and insurance requirements for a new marketplace.', 'unknown')],
      recommendation: {
        verdict: 'decline', summary: 'Single-city clone with a fee-only wedge against strong network effects. Expected return doesn’t justify tokens.',
        rationale: [c('Max realistic revenue ~$72K/yr in base-to-upside cases.'), c('No founder edge in supply or trust.')],
        tier: 'micro', complianceFlags: [],
        tokenTranche: { totalTokens: 0, lineItems: [], expectedReturn: c('Even a 1M-token MVP would struggle to pay back given the SOM.') },
        founderCommitments: [{ action: 'If you continue, run 20 manual bookings with a sitter partner', successSignal: '20 completed bookings, 5 repeat', dueWeek: 6 }],
        nextSteps: ['Validate manually without software', 'Come back if repeat demand is strong'],
        checkInWeeks: null,
      },
    }),
    decision: { decision: 'declined', tokensApproved: 0, founderNote: 'Not a fit right now. Happy to look again if manual bookings show strong repeat demand.' },
  },
  {
    id: 'sample-essays', title: 'Undetectable AI essay service for students', founder: { name: 'Alex Morgan', email: 'alex@sample.lfg.local' }, daysAgo: 4,
    messages: [['user', 'I want to sell AI-written essays to students that pass plagiarism and AI detectors.']],
    assessment: () => ({
      status: 'provisional', missingInputs: ['None needed: venture is not fundable'],
      assumptions: [c('Product is designed to help students submit work that is not their own.', 'self-report')],
      founderFit: {
        rationale: [c('Not assessed: the venture is out of policy.')],
        capabilityGaps: [c('Not assessed.')],
        distributionGaps: [c('Not assessed.')],
        recommendedChanges: [c('Consider legitimate tutoring or study tools instead.')],
      },
      opportunity: {
        customerPain: [c('Students under deadline pressure.')],
        competition: [c('Contract-cheating services, which many jurisdictions restrict.')],
        opportunity: [c('Not pursued: facilitates academic fraud.')],
      },
      units: { currency: 'USD', period: 'year', geography: 'Global' },
      market: {
        tam: calc(null, null, 'Not sized.', 'Out of policy.'),
        sam: calc(null, null, 'Not sized.', 'Out of policy.'),
        som: calc(null, null, 'Not sized.', 'Out of policy.'),
      },
      revenue: {
        conservative: calc(null, null, 'Not sized.', 'Out of policy.'),
        base: calc(null, null, 'Not sized.', 'Out of policy.'),
        upside: calc(null, null, 'Not sized.', 'Out of policy.'),
      },
      financing: {
        venture: [c('Not applicable.')],
        bootstrapping: [c('Not applicable.')],
        profitSharing: [c('Not applicable.')],
      },
      gtm: {
        targetSegment: [c('Not applicable.')],
        channels: [c('Not applicable.')],
        experiments: [{ experiment: c('None.'), suggestedBudget: null, budgetAssumptions: [c('Out of policy.', 'unknown')] }],
      },
      milestones: {
        validation: milestone('None.', null, null, ['Not applicable']),
        mvp: milestone('None.', null, null, ['Not applicable']),
        firstUser: milestone('None.', null, null, ['Not applicable']),
        firstRevenue: milestone('None.', null, null, ['Not applicable']),
      },
      uncertainties: [c('Not applicable.')],
      recommendation: {
        verdict: 'prohibited', summary: 'Designed to evade academic-integrity checks so students submit work that isn’t theirs. LFG won’t fund it.',
        rationale: [c('Core value proposition is deception of institutions.')],
        tier: null,
        complianceFlags: [c('Facilitates academic fraud; contract cheating is illegal in several jurisdictions (e.g. UK, Australia).'), c('Explicitly aims to evade detection systems.')],
        tokenTranche: { totalTokens: 0, lineItems: [], expectedReturn: c('Not applicable.') },
        founderCommitments: [],
        nextSteps: ['No funding', 'Founder may propose a legitimate study-support product instead'],
        checkInWeeks: null,
      },
    }),
    decision: { decision: 'prohibited', tokensApproved: 0, founderNote: 'We can’t support products built to evade academic integrity checks.', internalNote: 'Policy: academic fraud.' },
  },
  {
    id: 'sample-restaurant', title: 'Inventory forecasting for small restaurants', founder: { name: 'Sofia Alvarez', email: 'sofia@sample.lfg.local' }, daysAgo: 0,
    messages: [
      ['user', 'I manage two taquerias in San Diego and throw away about 12% of produce every week. Could AI forecast orders from POS data?'],
      ['assistant', 'Waste at **12%** is a strong, measurable pain. Which POS do you use, and do you know 10 owners with the same problem?'],
    ],
  },
];

// ---- write ----------------------------------------------------------------
let count = 0;
for (const [i, s] of samples.entries()) {
  let userId = owner.id;
  if (s.founder) {
    userId = `sample-user-${i}`;
    await db.insert(users).values({ id: userId, name: s.founder.name, email: s.founder.email, emailVerified: true });
  }
  const at = day(s.daysAgo);
  await db.insert(ventureConversations).values({ id: s.id, userId, title: s.title, createdAt: day(s.daysAgo + 2), updatedAt: at });
  for (const [n, [role, content]] of s.messages.entries()) {
    const when = new Date(day(s.daysAgo + 1).getTime() + n * 60_000);
    await db.insert(ventureMessages).values({ id: `${s.id}-m${n}`, conversationId: s.id, role, content, requestId: `${s.id}-r${Math.floor(n / 2)}`, status: 'completed', createdAt: when });
  }
  const sourceIds: string[] = [];
  for (const source of s.sources ?? []) {
    const [row] = await db.insert(ventureSources).values({ conversationId: s.id, turnId: `${s.id}-r0`, url: source.url, title: source.title, excerpt: source.excerpt, retrievedAt: day(s.daysAgo + 1) }).returning();
    sourceIds.push(row!.id);
  }
  if (s.assessment) {
    // Same validation as live assessments: sample data can't drift from the schema.
    const content = validateAssessment(s.assessment(sourceIds), new Set(sourceIds));
    const [assessment] = await db.insert(ventureAssessments).values({ id: `${s.id}-a1`, conversationId: s.id, version: 1, status: content.status, contentJson: content, createdAt: at }).returning();
    await saveTasks(s.id, assessment!);
    for (const position of s.done ?? []) {
      const tasks = await db.select().from(ventureTasks).where(eq(ventureTasks.assessmentId, assessment!.id));
      const task = tasks.find(t => t.position === position);
      if (task) await db.update(ventureTasks).set({ done: true, doneAt: at }).where(eq(ventureTasks.id, task.id));
    }
    if (s.decision) await db.insert(ventureDecisions).values({ id: `${s.id}-d1`, conversationId: s.id, assessmentId: assessment!.id, assessmentVersion: 1, adminUserId: owner.id, createdAt: at, ...s.decision });
  }
  count++;
}
console.log(`Seeded ${count} sample ventures (3 owned by ${ownerEmail}, ${count - 3} by sample founders).`);
process.exit(0);
