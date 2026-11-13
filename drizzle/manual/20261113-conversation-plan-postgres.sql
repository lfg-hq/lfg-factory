CREATE TABLE IF NOT EXISTS conversation_plan (
  conversation_id text PRIMARY KEY REFERENCES conversation(id) ON DELETE CASCADE,
  items jsonb NOT NULL,
  updated_at timestamp NOT NULL DEFAULT now()
);
