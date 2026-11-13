CREATE TABLE IF NOT EXISTS meeting (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  project_id text,
  conversation_id text REFERENCES conversation(id) ON DELETE SET NULL,
  title text NOT NULL DEFAULT 'Meeting',
  meeting_url text NOT NULL,
  platform text NOT NULL DEFAULT 'unknown',
  provider text NOT NULL DEFAULT 'recall',
  bot_id text,
  webhook_token text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'joining',
  status_detail text,
  context_seq integer NOT NULL DEFAULT 0,
  created_at integer NOT NULL DEFAULT (unixepoch()),
  started_at integer,
  ended_at integer
);
CREATE INDEX IF NOT EXISTS meeting_user_idx ON meeting(user_id);
CREATE INDEX IF NOT EXISTS meeting_project_idx ON meeting(project_id);
CREATE INDEX IF NOT EXISTS meeting_bot_idx ON meeting(bot_id);
CREATE TABLE IF NOT EXISTS meeting_segment (
  id text PRIMARY KEY,
  meeting_id text NOT NULL REFERENCES meeting(id) ON DELETE CASCADE,
  seq integer NOT NULL,
  kind text NOT NULL DEFAULT 'speech',
  speaker text NOT NULL DEFAULT 'Someone',
  text text NOT NULL,
  offset_seconds real,
  created_at integer NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS meeting_segment_meeting_idx ON meeting_segment(meeting_id, seq);
