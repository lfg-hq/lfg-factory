# Document graph

Branch: `codex/document-knowledge-graph`.

Open **Documents → Document map** in chat or the project documents panel. Select a node to inspect its connections and supporting evidence. Search and type filters narrow the map; the map shows up to 160 nodes at once. Existing epic ownership, epic document links, and ticket source-document relationships are confirmed edges. Dashed edges are model suggestions, with accept/dismiss controls. Documents, uploads, and connected sources can be tagged to epics. Map decisions are personal to the current user; existing project links remain shared.

## Storage and deployment

The SQLite and PostgreSQL schema exports include `document_graph`, `document_graph_source`, and `document_graph_link`. Apply the generated, additive migration for your database before running the updated server:

- `drizzle/manual/20261009-document-graph-sqlite.sql`
- `drizzle/manual/20261009-document-graph-postgres.sql`

These isolated migrations were generated from the graph schemas to avoid including unrelated schema changes already present in this checkout. The normal schema-push development workflow also creates the tables. No existing development or production database was changed during implementation.

## Background processing

Document events enroll the project owner's graph; uploads enroll their uploader; supported connected-source reads enroll the acting user's graph. Opening a map backfills an existing project for that user. A worker checks enrolled graphs every 15 seconds and reconciles each at most once per minute. It reads bounded excerpts, ranks up to 24 candidates, and processes at most eight documents per batch with a tool-free classifier. Other documents remain pending for subsequent batches. Existing explicit edges are always read live.

The worker uses an available lightweight model in the user's authorized authentication mode. `DOCUMENT_GRAPH_MODEL` can prefer a catalog model key available to that account; otherwise it prefers luna/mini/haiku/flash/lite. No environment API-key fallback is allowed. Usage is attributed to `document-graph`. Model output is validated against the supplied IDs, relation types, and a minimum confidence of 0.75. Confidence is the model's estimate, not a calibrated probability.

Unchanged corpora skip extraction and model calls. Content changes invalidate suggestions and trigger reconsideration of the corpus, including earlier documents. Each successful classification is checkpointed. Database leases prevent duplicate workers across server processes; expired leases resume after a restart. Provider errors retain confirmed relationships, expose a retry action, and back off for five minutes. Background scans recheck project membership before accessing content.

## Source boundaries and limitations

- Project documents are shared according to project membership. Uploads and external source snapshots are scoped to their owner and project; they never enter another user's model prompt or map.
- Connected sources are snapshots of document reads performed through the Composio tools in project chat. Merely connecting an account does not crawl it. Supported read results include Notion, Google Docs/Drive, and Confluence; direct and multi-execute responses are recognized. Only document text fields are retained, not entire tool envelopes or request arguments. Unsupported result shapes are skipped. Later reads refresh the snapshot; upstream changes and deletions are not synchronized automatically.
- TXT/Markdown and other supported text formats, plus DOCX, can be read. PDF, images, and other unsupported uploads still appear and can be linked manually. Files above the existing 20 MB reading limit cannot be analyzed. Excerpts are bounded, so a suggested graph is not exhaustive.
- No source content is sent to the graph UI. Names, relationships, evidence, and authorized source URLs are shown. Document text remains untrusted data and the classifier has no action tools.
- Map decisions are personal in this first version. To change a shared epic-to-document link, use the existing project document/epic workflow.

## Verification

- `bun run typecheck`
- `bun run check:schema`
- `bun test tests/document-graph.test.ts`
- `bun scripts/test-document-graph-integration.ts` (creates and removes its own temporary SQLite database)
- `node scripts/test-document-graph-browser.mjs` (temporary headless Chrome profile; override `CHROME_PATH` if needed)

The integration checks cover privacy boundaries, explicit links, durable decisions, stale suggestions, deleted nodes, unchanged-content caching, provider failure, and expired lease recovery. Browser checks use mocked graph responses; live provider credentials and live Composio accounts are not needed for these tests.
