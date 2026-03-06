CREATE TABLE `public_instant_chat` (
  `id` text PRIMARY KEY NOT NULL,
  `channel` text NOT NULL,
  `external_id` text NOT NULL,
  `conversation_id` text REFERENCES `conversations`(`id`) ON DELETE SET NULL,
  `display_name` text,
  `created_at` integer NOT NULL DEFAULT (unixepoch()),
  `updated_at` integer NOT NULL DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE UNIQUE INDEX `public_instant_channel_ext_idx` ON `public_instant_chat` (`channel`, `external_id`);
--> statement-breakpoint
CREATE INDEX `public_instant_conversation_idx` ON `public_instant_chat` (`conversation_id`);
