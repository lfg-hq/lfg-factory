CREATE TABLE "document_graph_link" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"source" text NOT NULL,
	"target" text NOT NULL,
	"relation" text NOT NULL,
	"decision" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_graph_source" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"content" text NOT NULL,
	"url" text,
	"provider" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_graph" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"checked_at" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_graph_link" ADD CONSTRAINT "document_graph_link_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_graph_link" ADD CONSTRAINT "document_graph_link_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_graph_source" ADD CONSTRAINT "document_graph_source_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_graph_source" ADD CONSTRAINT "document_graph_source_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_graph" ADD CONSTRAINT "document_graph_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_graph" ADD CONSTRAINT "document_graph_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_graph_link_unique" ON "document_graph_link" USING btree ("project_id","user_id","source","target","relation");--> statement-breakpoint
CREATE UNIQUE INDEX "document_graph_project_user" ON "document_graph" USING btree ("project_id","user_id");