CREATE TABLE IF NOT EXISTS `share_link` (
  `id` text PRIMARY KEY NOT NULL,
  `token` text NOT NULL,
  `project_id` text NOT NULL REFERENCES `project`(`id`) ON DELETE CASCADE,
  `resource_type` text NOT NULL,
  `resource_id` text NOT NULL,
  `created_by_id` text NOT NULL REFERENCES `user`(`id`) ON DELETE CASCADE,
  `is_active` integer NOT NULL DEFAULT 1,
  `expires_at` integer,
  `view_count` integer NOT NULL DEFAULT 0,
  `created_at` integer NOT NULL DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `share_link_token_unique` ON `share_link` (`token`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `sl_project_idx` ON `share_link` (`project_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `sl_token_idx` ON `share_link` (`token`);
