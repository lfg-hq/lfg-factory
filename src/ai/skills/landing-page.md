---
name: landing-page
description: Building or editing a content/marketing page — landing or home page, About, Pricing, Contact, FAQ, Blog or Docs. Covers the whole loop: inline wireframe, settling the copy in chat, offering a rendered preview, and turning the approved design into one ticket. NOT for app screens, dashboards or auth flows.
---

## Content & Landing Pages — Lightweight Page Path

When the user asks for a **content / marketing page** — a landing or home page, About, Pricing, Contact, Blog, Docs, or a similar layout-driven page (NOT a full app, dashboard, auth flow, or interactive app screen) — do NOT run the greenfield pipeline. Skip the PRD, personas, and Technical Analysis for a single page. Use this faster loop instead:

1. **Sketch a loose wireframe INLINE in your chat reply** — as a text/ASCII wireframe inside a fenced code block, so it renders monospaced and the boxes line up. This is just text in your message; do NOT call a tool or save a document to "draw" it. Keep it LOOSE — blocks and short labels, not pixel-perfect. Lay the page out top-to-bottom as stacked sections (nav, hero, features, social proof, CTA, footer, …) using box-drawing characters (┌ ─ ┐ │ ├ ┤ └ ┘) with a short label for what lives in each block. One sentence of context above it is fine.

   Example shape (adapt the sections to what the user actually wants — don't copy it verbatim):
   ```
   ┌───────────────────────────────────────────┐
   │  LOGO           nav  nav  nav    [ Sign up ]│
   ├───────────────────────────────────────────┤
   │              HERO — big headline            │
   │              one-line subhead               │
   │           [ Primary CTA ]   [ Demo ]        │
   ├───────────────────────────────────────────┤
   │   ▣ Feature      ▣ Feature      ▣ Feature   │
   │   short copy     short copy     short copy  │
   ├───────────────────────────────────────────┤
   │   " Testimonial quote "        — Name, Co.  │
   ├───────────────────────────────────────────┤
   │            Final CTA banner   [ Get started ]│
   ├───────────────────────────────────────────┤
   │   Footer · links · social · © [year]        │
   └───────────────────────────────────────────┘
   ```

2. **Invite quick edits.** Under the wireframe, list the sections in order as one short line and ask if they'd add / remove / reorder any. Keep this a loose back-and-forth in plain chat — NOT a formal `confirmAction` gate. Redraw the wireframe inline each time they tweak it.

3. **Design preferences — read the app FIRST, then ask only what's left.** A landing page
   for an EXISTING product should look like that product. Before asking anything about
   colours or style, `queryCodebase` for the app's own palette and typography (theme
   config, CSS custom properties, tailwind theme, design-system folder) and check for a
   Design Language doc.

   If the app has a style, say what it is and offer to keep it rather than presenting a
   blank menu — "the app uses indigo #4F46E5 on slate; keep that for the page?" with
   options like ("Keep the app's colours", "Same palette, marketing-friendlier",
   "Something new"). Users should not be asked to re-decide things their product has
   already decided.

   Ask the rest (vibe, inspiration) in ONE short `askUser` round, dropping any question
   the codebase already answers. Don't block the page on a full Design Language doc.

3b. **Settle the CONTENT first. Offer the preview; don't just produce one.**

   A preview is expensive — it regenerates a whole page, takes about a minute, and
   makes the conversation feel like it restarts. Copy is settled far faster in plain
   chat. So work in this order:

   a. Iterate on the words in chat: headline, sub-head, section copy, FAQs, CTA text.
      Show the changed text inline as a short list or a quote — NOT a re-rendered page.
      Keep flagging anything you had to invent (placeholder stats, pricing, claims) so
      the user can correct it before it's baked in.
   b. When the content stops moving — the user stops asking for changes, or says
      something like "that's it" / "looks good" — ASK: "Want me to render a quick
      preview of this?" Wait for a yes.
   c. Only then call `previewPage({ projectId, userId, name, html })` with a COMPLETE
      self-contained HTML document (all CSS in one `<style>` block, no external files —
      inline SVG or CSS gradients for imagery). Use the app's own palette and typography
      (you read them in step 3), and write the REAL copy you just agreed, never lorem
      ipsum.

   After a preview exists, the same rule holds: a content tweak is a chat reply, not a
   re-render. Make the edit in words, confirm it reads right, and offer to refresh the
   preview once several changes have accumulated or the user asks. Re-rendering on every
   small edit is what makes this slow and repetitive.

   Regenerate immediately WITHOUT asking only when the user explicitly asks for the
   preview, or when what changed is visual rather than textual (colours, layout, section
   order) — words can be judged in chat, a layout cannot.

4. **Build on approval.** When the user is happy ("looks good", "build it", "go"), that approval IS your go-ahead — go straight to `createTickets()` (no extra `confirmAction` popup for this path) with ONE well-scoped ticket for the page. Fold the approved section order + design cues directly into the ticket's **UI / UX** section (list each section top-to-bottom and what it contains), so the build agent builds the layout you both agreed on. When you produced a `previewPage`, quote the `referenceForTicket` line it returned in that section verbatim — the approved HTML is a saved document, and the build agent should match it rather than reinvent the design from prose. Then `scheduleTickets()`.

If it turns out the request is really a full product or interactive app, switch to the Greenfield / Existing-project workflow — you may still open with an inline wireframe of the key screen if it helps, but those need the PRD/architecture steps.
