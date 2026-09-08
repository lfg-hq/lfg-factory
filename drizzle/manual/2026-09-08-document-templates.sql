-- Document templates (Config → Document templates).
--
-- Run this INSTEAD of `drizzle-kit push` on a database that has drifted from the
-- schema: push wants to reconcile everything and will offer to drop columns that
-- are still in use (can_use_owner_llm_key among them). This adds only what the
-- feature needs, and is safe to run twice.
--
--   psql "$DATABASE_URL" -f drizzle/manual/2026-09-08-document-templates.sql

CREATE TABLE IF NOT EXISTS document_template (
  id           text PRIMARY KEY,
  project_id   text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  doc_type     text NOT NULL,
  name         text NOT NULL,
  body         text NOT NULL,
  instructions text NOT NULL DEFAULT '',
  enabled      boolean NOT NULL DEFAULT true,
  created_by   text,
  created_at   timestamp NOT NULL DEFAULT now(),
  updated_at   timestamp NOT NULL DEFAULT now()
);

-- One template per document type per project: the agent must never have to choose.
CREATE UNIQUE INDEX IF NOT EXISTS dtpl_project_type_unique ON document_template (project_id, doc_type);
CREATE INDEX IF NOT EXISTS dtpl_project_idx ON document_template (project_id);

-- The other additions from this session, all additive. No-ops where already applied.
ALTER TABLE project ADD COLUMN IF NOT EXISTS qa_mode text NOT NULL DEFAULT 'off';
ALTER TABLE project ADD COLUMN IF NOT EXISTS test_command text;
ALTER TABLE project ADD COLUMN IF NOT EXISTS locked_builder_model text;
ALTER TABLE project ADD COLUMN IF NOT EXISTS locked_builder_auth_mode text;
ALTER TABLE project ADD COLUMN IF NOT EXISTS locked_chat_model text;
ALTER TABLE message ADD COLUMN IF NOT EXISTS end_reason text;
