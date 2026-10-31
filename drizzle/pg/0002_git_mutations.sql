CREATE TABLE "git_mutations" (
	"id" text PRIMARY KEY NOT NULL,
	"operation_key" text NOT NULL,
	"active_key" text,
	"project_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"repo" text NOT NULL,
	"provider" text NOT NULL,
	"type" text NOT NULL,
	"head_ref" text NOT NULL,
	"base_ref" text NOT NULL,
	"head_sha" text NOT NULL,
	"base_sha" text NOT NULL,
	"status" text NOT NULL,
	"acknowledged_at" timestamp NOT NULL,
	"result" text,
	"error_code" text,
	"provider_request_id" text,
	"correlation_id" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX git_mutations_key_idx ON git_mutations (operation_key);
--> statement-breakpoint
CREATE UNIQUE INDEX git_mutations_active_idx ON git_mutations (active_key);
--> statement-breakpoint
ALTER TABLE git_mutations ADD CONSTRAINT git_mutations_project_fk FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE;
