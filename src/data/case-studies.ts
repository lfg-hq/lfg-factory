/**
 * Case study content.
 *
 * IMPORTANT — the `metrics` on each study are the credibility of the whole
 * site. A proposition this strong cannot afford a number anyone could catch
 * out, so anything not yet measured stays `null` and renders as an em dash.
 * Fill them in from the real project record; never estimate them.
 *
 * Everything in `challenge`, `scope`, `execution`, `human` and `outcome` is
 * descriptive and safe to write from what the product actually did.
 */

export interface CaseMetric {
  label: string;
  /** null renders as an em dash. Only ever set this from measured data. */
  value: string | null;
  hint?: string;
}

export interface CaseStudy {
  slug: string;
  name: string;
  tagline: string;
  summary: string;
  image: string;
  url?: string;
  stack: string[];
  challenge: string;
  scope: string;
  execution: string[];
  human: string[];
  outcome: string;
  metrics: CaseMetric[];
}

const UNMEASURED: CaseMetric[] = [
  { label: "Tickets delivered", value: null },
  { label: "Calendar duration", value: null },
  { label: "Human reviewers", value: null },
  { label: "Accepted without major rework", value: null, hint: "share of tickets passing review first time" },
  { label: "Tests written", value: null },
  { label: "Model spend", value: null },
];

export const CASE_STUDIES: CaseStudy[] = [
  {
    slug: "mags",
    name: "Mags",
    tagline: "Job-runner platform",
    summary: "A scheduled job-running platform, taken from requirements through to production on the factory.",
    image: "/public/images/screenshots/mags.png",
    stack: ["TypeScript", "Node", "Postgres", "Docker"],
    challenge:
      "Running scheduled and long-lived jobs reliably means handling the unglamorous cases: retries, partial failures, visibility into what ran and what did not, and an operator interface that makes a stuck job obvious rather than silent.",
    scope:
      "A full product rather than a feature — scheduling, execution, persistence, an operator-facing interface and the deployment around it.",
    execution: [
      "The requirement was written up as a specification with acceptance criteria before implementation began.",
      "Work was decomposed into a dependency-aware ticket graph so independent pieces could be built in parallel.",
      "Each ticket ran in an isolated environment on its own branch, with a working preview attached.",
      "Verification ran against the acceptance criteria, not only against the tests the implementer chose to write.",
    ],
    human: [
      "Architecture decisions reviewed before the ticket graph was executed.",
      "Every merge approved by an engineer, with the approval recorded against the ticket.",
      "Security-sensitive paths reviewed by hand rather than accepted on test results alone.",
    ],
    outcome:
      "Running in production and used daily. The requirements, decisions, tickets and reviews that produced it remain queryable alongside the code.",
    metrics: UNMEASURED,
  },
  {
    slug: "easylogs",
    name: "Easylogs",
    tagline: "Developer observability platform",
    summary: "A log and observability product for developers, built end to end through the LFG pipeline.",
    image: "/public/images/screenshots/easylogs.png",
    stack: ["TypeScript", "Node", "Postgres"],
    challenge:
      "Observability products live or die on ingestion and query performance, and on an interface that makes a problem findable at the moment someone is under pressure to find it.",
    scope:
      "Ingestion, storage, query, and the developer-facing interface over the top, plus the infrastructure to run it.",
    execution: [
      "Existing code and prior architectural decisions were read as context before anything was planned.",
      "Large requirements were broken into tickets small enough to verify individually.",
      "Failures went back for a fix and re-ran the checks rather than arriving on a reviewer's desk.",
    ],
    human: [
      "Data model and retention decisions made by an engineer, not inferred by the pipeline.",
      "Review gate held on every release.",
    ],
    outcome:
      "Shipped and running, with the full trail from requirement to release preserved.",
    metrics: UNMEASURED,
  },
  {
    slug: "kitereach",
    name: "Kitereach",
    tagline: "Go-to-market product stack",
    summary: "An outreach and go-to-market product built for rapid iteration on top of the factory.",
    image: "/public/images/screenshots/kitereach.png",
    url: "https://kitereach.com",
    stack: ["TypeScript", "Node", "Postgres", "Third-party integrations"],
    challenge:
      "Go-to-market tooling is mostly integration surface — other people's APIs, their rate limits, their failure modes — and the requirements move while you are building.",
    scope:
      "A product stack spanning several third-party integrations, with the iteration speed to keep changing after launch.",
    execution: [
      "Each integration scoped as its own ticket chain so one flaky vendor could not block the rest.",
      "Changing requirements handled as re-scoping against a written specification rather than as argument.",
      "Working previews on every ticket, so behaviour could be checked before merge.",
    ],
    human: [
      "Integration contracts and error handling reviewed by an engineer.",
      "Release decisions held by a person throughout.",
    ],
    outcome:
      "Live and in use. Iteration continues through the same pipeline that produced the first version.",
    metrics: UNMEASURED,
  },
];

export const getCaseStudy = (slug: string) => CASE_STUDIES.find((c) => c.slug === slug);

/** True once someone has filled in at least one real number for a study. */
export const hasMetrics = (c: CaseStudy) => c.metrics.some((m) => m.value !== null);
