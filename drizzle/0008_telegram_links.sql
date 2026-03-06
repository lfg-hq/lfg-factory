DROP TABLE IF EXISTS `telegram_link`;
--> statement-breakpoint
CREATE TABLE `telegram_bot` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL REFERENCES `user`(`id`) ON DELETE cascade,
	`bot_token` text NOT NULL,
	`bot_username` text,
	`project_id` text,
	`conversation_id` text,
	`enabled` integer NOT NULL DEFAULT 1,
	`created_at` integer NOT NULL DEFAULT (unixepoch()),
	`updated_at` integer NOT NULL DEFAULT (unixepoch()),
	CONSTRAINT `telegram_bot_user_id_unique` UNIQUE(`user_id`)
);
