import { html } from "hono/html";

/**
 * The software lifecycle LFG automates — one definition for the whole site.
 *
 * The pages used to disagree with each other (six stages here, seven in the
 * hero, eight in the comparison). Every page that names the stages now reads
 * them from here, grouped by the two problems the product exists to solve:
 * deciding what to build, and verifying what got built. Implementation sits
 * between them on purpose — it is the part coding agents already do well.
 */

export interface Stage {
  num: number;
  name: string;
  icon: string;
  /** One line, used on the homepage and the platform page. */
  short: string;
}

export interface Phase {
  key: "decide" | "build" | "verify";
  label: string;
  who: string;
  stages: Stage[];
}

export const PHASES: Phase[] = [
  {
    key: "decide", label: "Decide what to build", who: "with your team",
    stages: [
      { num: 1, name: "Scope", icon: "scan-search", short: "Reads the request alongside your codebase, docs and tools, and asks what a good engineer would ask." },
      { num: 2, name: "Plan", icon: "map", short: "Settles the architecture and the technical approach before anything is built." },
      { num: 3, name: "Document", icon: "file-text", short: "Writes the PRD, acceptance criteria and technical docs, versioned as the plan changes." },
      { num: 4, name: "Ticket", icon: "list-checks", short: "Breaks the plan into dependency-aware tickets, each carrying its own definition of done." },
    ],
  },
  {
    key: "build", label: "Build", who: "in parallel sandboxes",
    stages: [
      { num: 5, name: "Implement", icon: "terminal", short: "Claude Code, Codex or Pi sessions execute tickets in isolated sandboxes, many at once." },
    ],
  },
  {
    key: "verify", label: "Verify what got built", who: "before you review",
    stages: [
      { num: 6, name: "Test", icon: "flask-conical", short: "Writes tests from the acceptance criteria and proves each one tests the change." },
      { num: 7, name: "QA", icon: "monitor-play", short: "Runs the app in an in-app preview, exercises the feature and records the evidence." },
    ],
  },
];

export const STAGES: Stage[] = PHASES.flatMap((p) => p.stages);

/**
 * The seven stages as one rail, grouped by phase. The build phase is visually
 * quieter than the two around it — that is the argument of the whole site.
 */
export const LifecycleRail = () => html`
<div class="rounded-2xl border border-slate-200 bg-white px-6 py-6 flex flex-col lg:flex-row gap-y-6">
  ${PHASES.map((phase, pi) => html`
    <div class="${phase.key === "decide" ? "lg:flex-[4]" : phase.key === "build" ? "lg:flex-[1.6]" : "lg:flex-[2.2]"} ${pi > 0 ? "lg:pl-7 lg:border-l lg:border-slate-200" : ""} ${pi < PHASES.length - 1 ? "lg:pr-7" : ""}">
      <p class="text-[11px] uppercase tracking-wider mb-3">
        <span class="font-bold ${phase.key === "build" ? "text-slate-400" : "text-brand-600"}">${phase.label}</span>
        <span class="text-slate-400 font-medium normal-case tracking-normal"> &middot; ${phase.who}</span>
      </p>
      <div class="flex flex-wrap gap-x-6 gap-y-2.5">
        ${phase.stages.map((s) => html`
          <div class="flex items-center gap-2">
            <span class="text-xs font-semibold text-slate-400 tabular-nums">${s.num}</span>
            <span class="text-sm font-semibold text-slate-800">${s.name}</span>
          </div>`)}
      </div>
    </div>`)}
</div>`;
