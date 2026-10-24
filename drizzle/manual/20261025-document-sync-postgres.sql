-- Document sync (bf9210e): where a user's project documents are published, and the
-- remote copy of each document. Matches src/db/schema/pg/document-sync.ts.
CREATE TABLE IF NOT EXISTS document_sync_target (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  provider text NOT NULL,
  destination text NOT NULL DEFAULT '',
  auto_sync boolean NOT NULL DEFAULT false,
  last_synced_at bigint,
  last_error text,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS document_sync_target_user_provider ON document_sync_target (user_id, provider);

CREATE TABLE IF NOT EXISTS document_sync_link (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  provider text NOT NULL,
  file_id text NOT NULL REFERENCES project_file(id) ON DELETE CASCADE,
  remote_id text,
  remote_url text,
  remote_version integer,
  content_hash text,
  synced_at bigint,
  error text
);
CREATE UNIQUE INDEX IF NOT EXISTS document_sync_link_unique ON document_sync_link (user_id, provider, file_id);
