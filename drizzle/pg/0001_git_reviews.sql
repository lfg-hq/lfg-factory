CREATE TABLE "git_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"operation_key" text NOT NULL,
	"active_key" text,
	"project_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"review_id" text NOT NULL,
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
CREATE TABLE "git_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"provider" text NOT NULL,
	"repo" text NOT NULL,
	"head_ref" text NOT NULL,
	"base_ref" text NOT NULL,
	"head_sha" text NOT NULL,
	"base_sha" text NOT NULL,
	"status" text NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"lease_id" text,
	"lease_until" timestamp,
	"next_attempt_at" timestamp NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"findings" text,
	"coverage" text,
	"summary" text,
	"limitations" text,
	"model" text,
	"model_provider" text,
	"provider_request_id" text,
	"error_code" text,
	"correlation_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "git_operations" ADD CONSTRAINT "git_operations_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_operations" ADD CONSTRAINT "git_operations_review_id_git_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."git_reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_reviews" ADD CONSTRAINT "git_reviews_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_reviews" ADD CONSTRAINT "git_reviews_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "git_operations_key_idx" ON "git_operations" USING btree ("operation_key");--> statement-breakpoint
CREATE INDEX "git_reviews_queue_idx" ON "git_reviews" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "git_reviews_project_idx" ON "git_reviews" USING btree ("project_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "git_operations_active_idx" ON "git_operations" ("active_key");
