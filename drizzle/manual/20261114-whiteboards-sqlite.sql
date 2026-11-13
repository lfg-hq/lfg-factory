CREATE TABLE IF NOT EXISTS whiteboard (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  project_id text NOT NULL,
  title text NOT NULL DEFAULT 'Untitled board',
  elements text NOT NULL DEFAULT '[]',
  version integer NOT NULL DEFAULT 0,
  created_at integer NOT NULL DEFAULT (unixepoch()),
  updated_at integer NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS whiteboard_project_idx ON whiteboard(project_id);
CREATE TABLE IF NOT EXISTS whiteboard_message (
  id text PRIMARY KEY,
  board_id text NOT NULL REFERENCES whiteboard(id) ON DELETE CASCADE,
  seq integer NOT NULL,
  user_id text,
  role text NOT NULL,
  content text NOT NULL,
  created_at integer NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS whiteboard_message_board_idx ON whiteboard_message(board_id, seq);
