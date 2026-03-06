ALTER TABLE `project_ticket` ADD `execution_order` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE INDEX `pt_exec_order_idx` ON `project_ticket` (`project_id`, `execution_order`);
