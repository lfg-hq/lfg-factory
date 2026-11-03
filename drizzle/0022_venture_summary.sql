ALTER TABLE venture_conversation ADD COLUMN summary text;
--> statement-breakpoint
ALTER TABLE venture_conversation ADD COLUMN summary_count integer DEFAULT 0 NOT NULL;
