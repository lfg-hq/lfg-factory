---
name: design-feature
description: UI/UX changes to app features, screens, dashboards, forms, navigation or multi-screen flows. Offer wireframes, render app-faithful HTML/CSS/JS mock screens with dummy data, and attach accepted designs to tickets.
---

## Design feature

For requests with UI/UX impact, offer this optional design step before implementation tickets. Backend-only work needs no design offer. Continue normal product and technical planning where applicable; this skill does not replace it.

1. **Offer the choice once per feature.** Ask whether the user wants to sketch/review wireframes or proceed directly. They may supply a sketch or ask you to propose one. If designs were already requested, proceed. If they decline, continue without asking again. For standalone content/marketing pages, also load `landing-page` for its lightweight planning workflow.

2. **Read the app before designing.** Use `queryCodebase` to inspect actual screens, shared layouts, components, theme tokens, CSS, typography, icons, spacing, navigation, responsive rules and interaction patterns. Read any Design Language document. Record concrete tokens and source paths to reuse. Mockups must look like screens of the existing app. Do not invent a new visual direction or claim fidelity without inspecting the app. If no design exists, settle a direction with the user.

3. **Sketch and iterate in chat.** Name the affected screens and transitions. Show loose inline wireframes and relevant empty, loading, error, validation and success states. Invite layout changes and settle labels/content before rendering. Use clearly identified, realistic synthetic records when data is unavailable. Never present dummy people or metrics as real.

4. **Render actual HTML screens.** Once the user agrees to rendered designs (or explicitly requests them), call `previewPage` once per screen/state, using a consistent feature prefix and screen number. Each screen becomes a saved HTML document and expandable review card. List the complete screen set in chat. Supply complete `html` and optional `css`, `js`, and `data`; these assets are embedded in the portable file. Match the app's shell and styles strictly, with responsive layouts and semantic controls. Include an understandable initial HTML state. JavaScript may simulate local tabs, validation, modals and dummy interactions; no network requests, credentials, real mutations or production integrations. Explain transitions between separate files in chat rather than linking nonexistent routes. Batch copy edits; visual revision requests authorize refreshing the affected screen.

5. **Review and acceptance.** Collect revisions or acceptance of the named screen set. A generated preview is a draft, not approval. Attach only accepted screens, scoping tickets accordingly for partial approval. Acceptance authorizes adding designs to the corresponding ticket; do not ask for a second confirmation. Schedule implementation only when building is also authorized. Review changes made after approval before attaching revised designs to new tickets.

6. **Attach the accepted files.** Pass every relevant preview ID in `createTickets.approvedDesignDocumentIds` (up to 20 per ticket; split larger work by flow). The tool creates independent copies and adds their references to the ticket. Do not also paste mutable draft IDs. In UI / UX, include screen order, transitions, states, responsive behavior, reused source paths/tokens, and which records are dummy data. Acceptance criteria must cover appearance, behavior and replacing mocks with real data.

The build agent receives the referenced HTML under `.lfg/design/`. Tickets must tell it to read every screen, reuse existing components and styling, preserve the accepted appearance and flow, and connect real data and services. Mockups are implementation references, not a separate app to embed or a reason to replace the project's stack.
