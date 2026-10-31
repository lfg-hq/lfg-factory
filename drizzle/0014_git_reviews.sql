CREATE TABLE `git_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`operation_key` text NOT NULL,
	`active_key` text,
	`project_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`review_id` text NOT NULL,
	`repo` text NOT NULL,
	`provider` text NOT NULL,
	`type` text NOT NULL,
	`head_ref` text NOT NULL,
	`base_ref` text NOT NULL,
	`head_sha` text NOT NULL,
	`base_sha` text NOT NULL,
	`status` text NOT NULL,
	`acknowledged_at` integer NOT NULL,
	`result` text,
	`error_code` text,
	`provider_request_id` text,
	`correlation_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`review_id`) REFERENCES `git_reviews`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `git_operations_key_idx` ON `git_operations` (`operation_key`);--> statement-breakpoint
CREATE TABLE `git_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`provider` text NOT NULL,
	`repo` text NOT NULL,
	`head_ref` text NOT NULL,
	`base_ref` text NOT NULL,
	`head_sha` text NOT NULL,
	`base_sha` text NOT NULL,
	`status` text NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`lease_id` text,
	`lease_until` integer,
	`next_attempt_at` integer NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`findings` text,
	`coverage` text,
	`summary` text,
	`limitations` text,
	`model` text,
	`model_provider` text,
	`provider_request_id` text,
	`error_code` text,
	`correlation_id` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `git_reviews_queue_idx` ON `git_reviews` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `git_reviews_project_idx` ON `git_reviews` (`project_id`,`created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX "git_operations_active_idx" ON "git_operations" ("active_key");
