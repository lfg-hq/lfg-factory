ALTER TABLE whiteboard ADD COLUMN share_token text;
ALTER TABLE whiteboard ADD COLUMN share_mode text;
CREATE UNIQUE INDEX IF NOT EXISTS whiteboard_share_token_unique ON whiteboard(share_token);
