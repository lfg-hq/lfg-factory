CREATE TABLE IF NOT EXISTS venture_work_item (
 id text PRIMARY KEY NOT NULL,
 conversation_id text NOT NULL REFERENCES venture_conversation(id) ON DELETE CASCADE,
 decision_id text REFERENCES venture_decision(id) ON DELETE SET NULL,
 work_type text NOT NULL, title text NOT NULL, deliverable text,
 tokens_budgeted integer DEFAULT 0 NOT NULL, tokens_spent integer DEFAULT 0 NOT NULL,
 status text DEFAULT 'planned' NOT NULL, started_at integer, shipped_at integer,
 created_at integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS venture_work_conv_idx ON venture_work_item (conversation_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS venture_event (
 id text PRIMARY KEY NOT NULL,
 conversation_id text NOT NULL REFERENCES venture_conversation(id) ON DELETE CASCADE,
 kind text NOT NULL, title text NOT NULL, detail text, tokens integer,
 occurred_at integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS venture_event_conv_idx ON venture_event (conversation_id, occurred_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS venture_metric (
 id text PRIMARY KEY NOT NULL,
 conversation_id text NOT NULL REFERENCES venture_conversation(id) ON DELETE CASCADE,
 name text NOT NULL, value real NOT NULL, note text,
 recorded_at integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS venture_metric_conv_idx ON venture_metric (conversation_id, name, recorded_at);
