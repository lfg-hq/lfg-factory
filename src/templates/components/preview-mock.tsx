import { html } from "hono/html";

/**
 * An illustration of a ticket's Preview and QA tabs, drawn in HTML.
 *
 * Verification is the half of the product the screenshots never showed, so the
 * hero leads with it. It is built from markup rather than a PNG so it stays
 * crisp, follows the site's dark mode, and can be changed with the copy. The
 * labels mirror the real tabs (in-app browser, acceptance criteria, the RED →
 * GREEN test check, the recorded walkthrough) — nothing here is a claim the
 * product does not make.
 */

const CRITERIA = [
  "Admins can invite a teammate by email",
  "Invite link expires after 7 days",
  "Non-admins don't see the invite button",
  "Duplicate invites show an inline error",
];

export const PreviewMock = ({ compact = false }: { compact?: boolean } = {}) => html`
<div class="shot max-w-full" aria-label="Illustration of a ticket's Preview and QA tabs in LFG" role="img">
  <div class="shot-bar">
    <span class="shot-dot bg-red-400/70"></span>
    <span class="shot-dot bg-amber-400/70"></span>
    <span class="shot-dot bg-emerald-400/70"></span>
    <span class="ml-2 text-xs font-mono text-slate-400 truncate">TKT-142 &middot; Invite teammates by email</span>
    <span class="ml-auto inline-flex items-center gap-1.5 text-[11px] font-semibold text-emerald-500 shrink-0">
      <span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span> verified
    </span>
  </div>

  <!-- Ticket tabs -->
  <div class="flex items-center gap-1 px-3 pt-2 border-b border-slate-100 text-[11px] font-semibold overflow-hidden">
    ${["Plan", "Build", "Diff"].map((t) => html`<span class="px-2.5 py-1.5 text-slate-400">${t}</span>`)}
    <span class="px-2.5 py-1.5 text-brand-700 border-b-2 border-brand-500 -mb-px">Preview</span>
    <span class="px-2.5 py-1.5 text-slate-400">QA</span>
  </div>

  <div class="grid grid-cols-1 ${compact ? "" : "sm:grid-cols-5"} gap-0">
    <!-- In-app browser running the changed app -->
    <div class="${compact ? "" : "sm:col-span-3"} p-3 border-b sm:border-b-0 ${compact ? "" : "sm:border-r"} border-slate-100">
      <div class="rounded-lg border border-slate-200 overflow-hidden bg-white">
        <div class="flex items-center gap-2 px-2.5 py-1.5 bg-slate-50 border-b border-slate-100">
          <i data-lucide="lock" class="w-3 h-3 text-slate-400"></i>
          <span class="text-[10px] font-mono text-slate-500 truncate">tkt-142.preview / settings / team</span>
        </div>
        <div class="p-3.5">
          <p class="text-[11px] font-bold text-slate-800 mb-2.5">Team members</p>
          <div class="space-y-1.5 mb-3">
            ${[["AK", "Ava Kim", "Admin"], ["RM", "Raj Mehta", "Member"]].map(([i, n, r]) => html`
              <div class="flex items-center gap-2">
                <span class="w-5 h-5 rounded-full bg-indigo-100 text-brand-700 text-[8px] font-bold flex items-center justify-center">${i}</span>
                <span class="text-[10.5px] text-slate-700 flex-1">${n}</span>
                <span class="text-[9.5px] text-slate-400">${r}</span>
              </div>`)}
          </div>
          <div class="flex gap-1.5">
            <span class="flex-1 rounded-md border border-brand-300 px-2 py-1 text-[10px] text-slate-600 font-mono">sam@acme.co</span>
            <span class="rounded-md bg-brand-600 text-white text-[10px] font-semibold px-2.5 py-1">Invite</span>
          </div>
          <div class="mt-2.5 inline-flex items-center gap-1.5 rounded-md bg-emerald-50 border border-emerald-200 px-2 py-1">
            <i data-lucide="check" class="w-3 h-3 text-emerald-600"></i>
            <span class="text-[10px] font-semibold text-emerald-700">Invitation sent to sam@acme.co</span>
          </div>
        </div>
      </div>
      <div class="mt-2.5 flex items-center gap-2 text-[10.5px] text-slate-500">
        <span class="w-6 h-6 rounded-full bg-slate-900 text-white flex items-center justify-center shrink-0"><i data-lucide="play" class="w-3 h-3"></i></span>
        <span><span class="font-semibold text-slate-700">Walkthrough recorded</span> &middot; 0:42 &middot; driven in a real browser</span>
      </div>
    </div>

    <!-- QA verdict -->
    <div class="${compact ? "" : "sm:col-span-2"} p-3.5">
      <p class="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">Acceptance criteria</p>
      <ul class="space-y-1.5 mb-4">
        ${CRITERIA.map((c) => html`
          <li class="flex gap-1.5 text-[10.5px] leading-snug text-slate-700">
            <i data-lucide="check-circle-2" class="w-3.5 h-3.5 text-emerald-500 shrink-0"></i>${c}
          </li>`)}
      </ul>
      <p class="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">Generated tests</p>
      <div class="space-y-1 text-[10.5px]">
        <div class="flex items-center justify-between"><span class="text-slate-600">Fail before, pass after</span><span class="font-semibold text-emerald-600">6 kept</span></div>
        <div class="flex items-center justify-between"><span class="text-slate-600">Passed before the change</span><span class="font-semibold text-slate-400">2 discarded</span></div>
        <div class="flex items-center justify-between"><span class="text-slate-600">Fail after the change</span><span class="font-semibold text-slate-500">0 reported</span></div>
      </div>
    </div>
  </div>
</div>`;
