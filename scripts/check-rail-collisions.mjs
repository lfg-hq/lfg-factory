/**
 * Which stylesheets fight the rail — bun run check:rail
 *
 * The rail reuses class names (.conversation-list / -item / -title) that page
 * stylesheets also use for unrelated components. Twice now a page-only sheet has
 * quietly restyled the rail: projects.css set the title to 1.125rem/600, and
 * project_detail.css set the list to a flex column with a 1rem gap. Both looked fine
 * in the markup and only showed up as "why is this page different".
 *
 * This lists every foreign rule on those selectors and checks sidebar.css carries a
 * scoped .conversations-section override for the layout properties they set.
 */
import fs from "node:fs";
import path from "node:path";

const CSS_DIR = "public/css";
const TARGETS = ["conversation-list", "conversation-item", "conversation-title"];
const RISKY = ["display", "gap", "font-size", "font-weight", "line-height", "margin", "margin-bottom", "padding", "min-height", "height"];

// Only the stylesheets the RAIL PAGES actually load. A rule in a sheet nobody links
// can't fight anything, and reporting it is noise.
const RAIL_PAGES = [
  "src/templates/pages/chat.tsx",
  "src/templates/pages/project-detail.tsx",
  "src/templates/pages/epics.tsx",
  "src/templates/pages/tickets-list.tsx",
];
const files = [...new Set(RAIL_PAGES.flatMap((p) =>
  [...fs.readFileSync(p, "utf8").matchAll(/href="\/public\/(css\/[\w./-]+\.css)"/g)].map((m) => "public/" + m[1])
))].filter((f) => fs.existsSync(f));
console.log(`stylesheets loaded by the rail pages: ${files.length}`);

const sidebar = fs.readFileSync(`${CSS_DIR}/sidebar.css`, "utf8");
const defended = new Set();
for (const m of sidebar.matchAll(/\.conversations-section[^{]*\{([^}]*)\}/g)) {
  for (const decl of m[1].split(";")) {
    const prop = decl.split(":")[0]?.trim();
    if (prop) defended.add(prop);
  }
}

let bad = 0;
for (const f of files) {
  if (f.endsWith("sidebar.css")) continue;
  const css = fs.readFileSync(f, "utf8");
  for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const sel = m[1].trim();
    // Match the class TOKEN, not a substring: .conversation-list-icon is a different
    // class and was being reported as a collision with .conversation-list.
    if (!TARGETS.some((t) => new RegExp(`\\.${t}(?![\\w-])`).test(sel))) continue;
    // Colour-only overrides are harmless; layout is what leaks.
    const props = m[2].split(";").map((d) => d.split(":")[0]?.trim()).filter(Boolean);
    const risky = props.filter((p) => RISKY.includes(p));
    if (!risky.length) continue;
    const unguarded = risky.filter((p) => !defended.has(p) && !(p === "margin" && defended.has("margin-bottom")));
    if (unguarded.length) {
      bad++;
      console.log(`  FAIL ${f}\n         ${sel.replace(/\s+/g, " ").slice(0, 70)} sets ${unguarded.join(", ")} — sidebar.css does not defend it`);
    }
  }
}
console.log(bad ? `\n${bad} unguarded collision(s)` : "\nthe rail is defended against every page stylesheet");
process.exit(bad ? 1 : 0);
