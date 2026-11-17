CREATE TABLE IF NOT EXISTS conversation_plan (
  conversation_id text PRIMARY KEY REFERENCES conversation(id) ON DELETE CASCADE,
  items text NOT NULL,
  updated_at integer NOT NULL DEFAULT (unixepoch())
);
