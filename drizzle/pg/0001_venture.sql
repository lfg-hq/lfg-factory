CREATE TABLE IF NOT EXISTS venture_conversation (
 id text PRIMARY KEY NOT NULL,
 user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 title text DEFAULT 'New conversation' NOT NULL,
 created_at timestamp DEFAULT now() NOT NULL, updated_at timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS venture_conv_owner_idx ON venture_conversation (user_id, updated_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS venture_message (
 id text PRIMARY KEY NOT NULL,
 conversation_id text NOT NULL REFERENCES venture_conversation(id) ON DELETE CASCADE,
 role text NOT NULL, content text NOT NULL, request_id text NOT NULL,
 status text DEFAULT 'started' NOT NULL, created_at timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS venture_msg_conv_idx ON venture_message (conversation_id, created_at);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS venture_msg_request_idx ON venture_message (conversation_id, request_id, role);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS venture_source (
 id text PRIMARY KEY NOT NULL,
 conversation_id text NOT NULL REFERENCES venture_conversation(id) ON DELETE CASCADE,
 turn_id text NOT NULL, url text NOT NULL, title text, retrieved_at timestamp DEFAULT now() NOT NULL, excerpt text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS venture_source_conv_idx ON venture_source (conversation_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS venture_assessment (
 id text PRIMARY KEY NOT NULL,
 conversation_id text NOT NULL REFERENCES venture_conversation(id) ON DELETE CASCADE,
 version integer NOT NULL, status text NOT NULL, content_json jsonb NOT NULL, created_at timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS venture_assessment_version_idx ON venture_assessment (conversation_id, version);
