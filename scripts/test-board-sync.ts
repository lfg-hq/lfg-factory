/**
 * Board-sync mapping tests: bun run scripts/test-board-sync.ts
 *
 * Covers the part that decides where a ticket LANDS, which is where a silent bug
 * costs the most: a stage that maps to nothing never reaches the board at all.
 * Pure functions only — no network, no database.
 */
import { autoMapStatuses } from "../src/services/boards/sync.ts";
import { normalizePriority, guessCategory } from "../src/services/boards/types.ts";
import { textToAdf, adfToText } from "../src/services/boards/jira.ts";

const stage = (name: string, order: number, isCompleted = false, isDefault = false) =>
  ({ id: "stage-" + name.toLowerCase().replace(/\W+/g, "-"), projectId: "p", name, color: "#000", order, isDefault, isCompleted, createdAt: new Date(), updatedAt: new Date() }) as any;

const LFG_STAGES = [
  stage("Backlog", 0, false, true), stage("Todo", 1), stage("In Progress", 2),
  stage("In Review", 3), stage("Failed / Blocked", 4), stage("Done", 5, true), stage("Archive", 6, true),
];

let failures = 0;
const check = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log((ok ? "  ok  " : "  FAIL") + "  " + label + (ok ? "" : `\n         got ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`));
};

console.log("\nJira-shaped board (To Do / In Progress / In Review / Done):");
const jira = [
  { id: "j1", name: "To Do", category: "todo" as const },
  { id: "j2", name: "In Progress", category: "in_progress" as const },
  { id: "j3", name: "In Review", category: "review" as const },
  { id: "j4", name: "Done", category: "done" as const },
];
const m1 = autoMapStatuses(LFG_STAGES, jira);
check("In Progress → In Progress", m1.toRemote["stage-in-progress"], "j2");
check("In Review  → In Review", m1.toRemote["stage-in-review"], "j3");
check("Done       → Done", m1.toRemote["stage-done"], "j4");
check("Todo       → To Do", m1.toRemote["stage-todo"], "j1");
check("Backlog    → To Do (no backlog column on this board)", m1.toRemote["stage-backlog"], "j1");
check("reverse: To Do comes back to Todo, not Backlog", m1.toLocal["j1"], "stage-todo");
check("every stage maps somewhere even without a Backlog column", LFG_STAGES.every((s) => !!m1.toRemote[s.id]), true);

console.log("\nLinear-shaped board (Backlog / Todo / In Progress / In Review / Done / Canceled):");
const linear = [
  { id: "l0", name: "Backlog", category: "backlog" as const },
  { id: "l1", name: "Todo", category: "todo" as const },
  { id: "l2", name: "In Progress", category: "in_progress" as const },
  { id: "l3", name: "In Review", category: "review" as const },
  { id: "l4", name: "Done", category: "done" as const },
  { id: "l5", name: "Canceled", category: "cancelled" as const },
];
const m2 = autoMapStatuses(LFG_STAGES, linear);
check("Backlog → Backlog", m2.toRemote["stage-backlog"], "l0");
check("Todo    → Todo", m2.toRemote["stage-todo"], "l1");
check("Archive → Canceled-ish (completed stage)", !!m2.toRemote["stage-archive"], true);
check("every stage got a mapping", LFG_STAGES.every((s) => !!m2.toRemote[s.id]), true);
check("every remote status can come back", linear.every((s) => !!m2.toLocal[s.id]), true);

console.log("\nOddly-named board (custom columns):");
const custom = [
  { id: "c1", name: "Icebox", category: undefined },
  { id: "c2", name: "Doing", category: undefined },
  { id: "c3", name: "QA", category: undefined },
  { id: "c4", name: "Shipped", category: undefined },
];
const m3 = autoMapStatuses(LFG_STAGES, custom);
check("Icebox reads as backlog", guessCategory("Icebox"), "backlog");
check("Doing reads as in progress", guessCategory("Doing"), "in_progress");
check("QA reads as review", guessCategory("QA"), "review");
check("Shipped reads as done", guessCategory("Shipped"), "done");
check("In Progress → Doing", m3.toRemote["stage-in-progress"], "c2");
check("In Review   → QA", m3.toRemote["stage-in-review"], "c3");
check("Done        → Shipped", m3.toRemote["stage-done"], "c4");

console.log("\nPriority normalization across both vocabularies:");
check("Highest → Critical", normalizePriority("Highest"), "Critical");
check("Urgent  → Critical", normalizePriority("Urgent"), "Critical");
check("Major   → High", normalizePriority("Major"), "High");
check("Normal  → Medium", normalizePriority("normal"), "Medium");
check("Trivial → Low", normalizePriority("Trivial"), "Low");
check("garbage → null", normalizePriority("Blah"), null);

console.log("\nJira ADF round-trip:");
const text = "Build the scheduler.\n\nIt must run daily and skip weekends.";
const doc = textToAdf(text);
check("doc has version (Jira rejects it otherwise)", (doc as any).version, 1);
check("two paragraphs", doc.content.length, 2);
check("round-trips back to the same text", adfToText(doc), text);
check("empty description is a valid empty doc", textToAdf("").content.length, 0);

console.log(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
process.exit(failures ? 1 : 0);
