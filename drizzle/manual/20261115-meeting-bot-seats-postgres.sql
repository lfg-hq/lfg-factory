CREATE TABLE IF NOT EXISTS meeting_bot_seat (
  id text PRIMARY KEY NOT NULL,
  workspace text NOT NULL UNIQUE,
  account text DEFAULT '' NOT NULL,
  state text DEFAULT 'needs_sign_in' NOT NULL,
  holder text,
  lease_until timestamp,
  last_used_at timestamp,
  last_error text,
  created_at timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS meeting_bot_seat_state_idx ON meeting_bot_seat (state);
