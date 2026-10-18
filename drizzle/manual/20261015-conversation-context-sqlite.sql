CREATE TABLE IF NOT EXISTS conversation_context (
  conversation_id text PRIMARY KEY REFERENCES conversation(id) ON DELETE CASCADE,
  summary text NOT NULL,
  through_id text NOT NULL,
  through_at integer NOT NULL
);
