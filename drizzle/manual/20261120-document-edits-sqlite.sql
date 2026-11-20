-- Who changed a document and how (Docs editor, raw markdown, or the agent), one row per editing session.
CREATE TABLE IF NOT EXISTS document_edit (
  id text PRIMARY KEY,
  file_id text NOT NULL REFERENCES project_file(id) ON DELETE CASCADE,
  user_id text REFERENCES user(id) ON DELETE SET NULL,
  source text NOT NULL,
  base_version integer,
  added_lines integer NOT NULL DEFAULT 0,
  removed_lines integer NOT NULL DEFAULT 0,
  created_at integer NOT NULL DEFAULT (unixepoch()),
  updated_at integer NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS de_file_idx ON document_edit(file_id, updated_at);
