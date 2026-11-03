ALTER TABLE venture_conversation ADD COLUMN IF NOT EXISTS summary text;
--> statement-breakpoint
ALTER TABLE venture_conversation ADD COLUMN IF NOT EXISTS summary_count integer DEFAULT 0 NOT NULL;
