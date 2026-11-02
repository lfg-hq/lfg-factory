CREATE TABLE IF NOT EXISTS venture_decision (
 id text PRIMARY KEY NOT NULL,
 conversation_id text NOT NULL REFERENCES venture_conversation(id) ON DELETE CASCADE,
 assessment_id text REFERENCES venture_assessment(id) ON DELETE SET NULL,
 assessment_version integer,
 decision text NOT NULL, tokens_approved integer DEFAULT 0 NOT NULL,
 founder_note text, internal_note text,
 admin_user_id text NOT NULL REFERENCES "user"(id),
 created_at integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS venture_decision_conv_idx ON venture_decision (conversation_id, created_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS venture_task (
 id text PRIMARY KEY NOT NULL,
 conversation_id text NOT NULL REFERENCES venture_conversation(id) ON DELETE CASCADE,
 assessment_id text NOT NULL REFERENCES venture_assessment(id) ON DELETE CASCADE,
 position integer NOT NULL, action text NOT NULL, success_signal text, due_week integer,
 done integer DEFAULT 0 NOT NULL, done_at integer,
 created_at integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS venture_task_assessment_idx ON venture_task (assessment_id, position);
