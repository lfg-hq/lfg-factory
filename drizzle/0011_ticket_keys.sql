ALTER TABLE `project` ADD COLUMN `ticket_counter` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `project_ticket` ADD COLUMN `ticket_key` text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `pt_project_key_unique` ON `project_ticket` (`project_id`, `ticket_key`);
