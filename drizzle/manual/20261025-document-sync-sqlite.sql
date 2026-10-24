-- Document sync (bf9210e). Matches src/db/schema/sqlite/document-sync.ts.
CREATE TABLE IF NOT EXISTS document_sync_target (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  provider text NOT NULL,
  destination text NOT NULL DEFAULT '',
  auto_sync integer NOT NULL DEFAULT 0,
  last_synced_at integer,
  last_error text,
  created_at integer NOT NULL DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX IF NOT EXISTS document_sync_target_user_provider ON document_sync_target (user_id, provider);

CREATE TABLE IF NOT EXISTS document_sync_link (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  provider text NOT NULL,
  file_id text NOT NULL REFERENCES project_file(id) ON DELETE CASCADE,
  remote_id text,
  remote_url text,
  remote_version integer,
  content_hash text,
  synced_at integer,
  error text
);
CREATE UNIQUE INDEX IF NOT EXISTS document_sync_link_unique ON document_sync_link (user_id, provider, file_id);
