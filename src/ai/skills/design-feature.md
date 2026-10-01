---
name: design-feature
description: Design or preview UI changes using exact source files and the real app layout; review interactive mockups before implementation. Use for requests to design, show UI, preview a feature, or revise screens and navigation.
---

## Design feature

This skill owns the design workflow. It does not schedule implementation or replace product/technical planning. A request to show/design/preview UI authorizes rendering; do not ask for preview permission again. Offer design once for UI-impacting work when it was not already requested. Skip if declined; backend-only work needs no offer.

### 1. Establish the actual screen

Use `queryCodebase` only to locate the shared layout/navigation, affected page, CSS and component dependencies. Then call `readDesignSource` with those exact paths and the intended branch. It returns actual files and a pinned commit, not a model summary. Read required dependencies in follow-up calls using that commit as the branch so sources cannot drift. Read the project's Design Language document if one exists.

Preserve menu labels, order, grouping, icons, active states, entry points and navigation flow. Do not infer these from theme tokens. If source and user screenshots disagree, identify the version discrepancy before calling a design faithful. Never read credentials or environment files.

### 2. Generate source-based HTML (default)

Generate self-contained HTML previews directly from the inspected source. No sandbox, running preview, screenshot capture, dependency installation or build is required for this workflow. Do not ask the user to start an environment just to design.

Read the actual shared navigation/layout, affected page and relevant CSS/components with `readDesignSource` before calling `previewPage` in this turn. The server tracks successful reads; a queryCodebase summary is not enough. Reuse the exact menu labels, order, groups, icons, active states, page structure, spacing and styles. Copy/adapt the real markup and CSS; do not reconstruct the app shell from colors or memory. For framework components, translate their rendered structure into standalone HTML while preserving their visual rules. Embed needed styles and inline SVG since external assets are blocked.

Only change the requested feature region. New controls belonging to the proposed feature are allowed and must be described as proposed. Do not invent existing menus, pages, buttons or navigation flows. If a dependency is missing, read it. If a detail cannot be established, state that specific gap rather than filling it in silently. When source differs from a supplied screenshot, flag the discrepancy and use the screenshot for visible appearance while preserving source-backed behavior.

Call `previewPage` with the complete HTML, optional CSS/JS and synthetic data. Do not pass baselineId for this default path. The result is labelled **Source-based design · sample data · not verified against the running app**. Source reads establish provenance, not pixel-perfect fidelity; compare the rendered result with supplied screenshots when available. Never claim to have visually verified something you did not inspect.

If source cannot be accessed, explain the specific missing reference and offer a limited approximate mockup. Only after the user accepts that fallback, pass `approximateReason`. New apps without a repository can use standalone mockups after agreeing the visual direction.

Show relevant initial, loading, empty, error, validation and success states as named preview cards with a consistent feature prefix. Keep captions short; no ASCII wireframes or duplicate text versions unless requested. Generate mobile HTML from the actual responsive rules, not desktop scaling alone.

### 3. Optional running-app comparison

Use `captureDesignLayout` only when the user wants a captured visual reference and a preview is already running, or when running the app is necessary to verify behavior. It is not a prerequisite for HTML design. If unavailable, continue the source-based workflow without a sandbox setup detour.

When using a capture, pass its `baselineId` to `previewPage` and provide HTML for ONLY the selected feature region. The surrounding app is an immutable screenshot; navigation there is static. Explain that limitation. Do not claim native component or behavior verification from a screenshot.

### 4. Review and revise

Ask the user to review the actual cards. Compare the proposal with their supplied references, noting any unresolved differences in the feature area. For source-based revisions, reread the relevant files at the same commit; check for intentional version changes. If an optional capture was used, reuse it only while its page/version is still applicable. Batch copy changes. Design changes authorize refreshing the affected screens, not implementation.

### 5. Attach accepted designs

Generated previews are drafts, not approval. After acceptance, pass all relevant IDs in `createTickets.approvedDesignDocumentIds` (up to 20 per ticket). Accepted files are copied independently. Do not also paste mutable draft IDs. Describe screen order, transitions, states, responsive behavior, source paths/commit and which data is synthetic in the ticket. Only schedule building when authorized.

The builder reads the accepted HTML references under `.lfg/design/`. It must implement the feature using the actual project's components and real data. A captured layout image is a design reference only: NEVER implement the application as a screenshot with an iframe. Preserve real navigation and existing architecture. The single-ticket Epic path must not claim automatic design attachment unless the references were actually added to its build ticket.
