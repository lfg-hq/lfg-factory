CREATE TABLE IF NOT EXISTS project_note (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'note',
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  secret_encrypted text,
  source text NOT NULL DEFAULT 'user',
  created_by text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS note_project_idx ON project_note(project_id);
