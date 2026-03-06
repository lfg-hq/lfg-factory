CREATE TABLE `project_activity` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL REFERENCES `project`(`id`) ON DELETE cascade,
	`ticket_id` text,
	`actor_type` text NOT NULL DEFAULT 'system',
	`activity_type` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`metadata` text,
	`created_at` integer NOT NULL DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE INDEX `pa_project_created_idx` ON `project_activity` (`project_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX `pa_ticket_idx` ON `project_activity` (`ticket_id`);
--> statement-breakpoint
CREATE INDEX `pa_activity_type_idx` ON `project_activity` (`activity_type`);
