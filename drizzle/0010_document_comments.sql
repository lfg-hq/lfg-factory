CREATE TABLE IF NOT EXISTS `document_comment` (
  `id` text PRIMARY KEY NOT NULL,
  `file_id` text NOT NULL REFERENCES `project_file`(`id`) ON DELETE CASCADE,
  `user_id` text NOT NULL REFERENCES `user`(`id`) ON DELETE CASCADE,
  `selected_text` text NOT NULL,
  `range_start` integer NOT NULL,
  `range_end` integer NOT NULL,
  `content` text NOT NULL,
  `parent_id` text,
  `is_resolved` integer NOT NULL DEFAULT 0,
  `resolved_by_id` text REFERENCES `user`(`id`) ON DELETE SET NULL,
  `resolved_at` integer,
  `created_at` integer NOT NULL DEFAULT (unixepoch()),
  `updated_at` integer NOT NULL DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `dc_file_idx` ON `document_comment` (`file_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `dc_parent_idx` ON `document_comment` (`parent_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `dc_user_idx` ON `document_comment` (`user_id`);
