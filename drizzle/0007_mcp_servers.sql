CREATE TABLE `mcp_server` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL REFERENCES `user`(`id`) ON DELETE CASCADE,
	`name` text NOT NULL,
	`transport_type` text NOT NULL,
	`url` text NOT NULL,
	`headers` text,
	`enabled` integer NOT NULL DEFAULT 1,
	`created_at` integer NOT NULL DEFAULT (unixepoch())
);
