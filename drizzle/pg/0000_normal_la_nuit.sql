CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "application_state" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"sidebar_minimized" boolean DEFAULT false NOT NULL,
	"last_selected_model" text DEFAULT 'gpt-5-mini' NOT NULL,
	"last_selected_role" text DEFAULT 'product_analyst' NOT NULL,
	"turbo_mode_enabled" boolean DEFAULT false NOT NULL,
	"claude_code_enabled" boolean DEFAULT false NOT NULL,
	"builder_model_key" text DEFAULT 'claude_4.5_sonnet',
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "application_state_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "email_verification_code" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"code" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"used" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_verification_token" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"used" boolean DEFAULT false NOT NULL,
	CONSTRAINT "email_verification_token_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "external_services_api_key" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"linear_api_key" text,
	"jira_api_key" text,
	"notion_api_key" text,
	"google_docs_api_key" text,
	CONSTRAINT "external_services_api_key_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "github_token" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text NOT NULL,
	"github_user_id" text,
	"github_username" text,
	"github_avatar_url" text,
	"scope" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "github_token_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "llm_api_key" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"openai_api_key" text,
	"anthropic_api_key" text,
	"xai_api_key" text,
	"google_api_key" text,
	"kimi_api_key" text,
	"free_trial" boolean DEFAULT true NOT NULL,
	"use_personal_llm_keys" boolean DEFAULT false NOT NULL,
	CONSTRAINT "llm_api_key_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "profile" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"bio" text DEFAULT '',
	"avatar" text,
	"sidebar_collapsed" boolean DEFAULT false NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"has_seen_onboarding" boolean DEFAULT false NOT NULL,
	"claude_code_authenticated" boolean DEFAULT false NOT NULL,
	"claude_code_s3_key" text,
	"claude_code_credentials" text,
	"claude_code_credentials_updated_at" timestamp,
	"cli_api_key" text,
	"current_organization_id" text,
	"allow_project_invitations" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "profile_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "profile_cli_api_key_unique" UNIQUE("cli_api_key")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp,
	"updated_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "organization_invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"inviter_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"token" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"responded_at" timestamp,
	CONSTRAINT "organization_invitation_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "organization_membership" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"joined_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"owner_id" text NOT NULL,
	"description" text DEFAULT '',
	"avatar" text,
	"stripe_customer_id" text,
	"allow_member_invites" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "organization_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "agent_role" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text DEFAULT 'product_analyst' NOT NULL,
	"turbo_mode" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_role_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "chat_file" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"message_id" text,
	"file_path" text NOT NULL,
	"original_filename" text NOT NULL,
	"file_type" text DEFAULT '',
	"file_size" integer DEFAULT 0 NOT NULL,
	"uploaded_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"title" text,
	"project_id" text,
	"design_canvas_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"content_if_file" jsonb DEFAULT '[]'::jsonb,
	"user_role" text DEFAULT 'default',
	"is_partial" boolean DEFAULT false NOT NULL,
	"tool_steps" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_updated" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_selection" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"selected_model" text DEFAULT 'gpt-5-mini' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "model_selection_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "project_code_generation" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"folder_name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "project_code_generation_project_id_unique" UNIQUE("project_id"),
	CONSTRAINT "project_code_generation_folder_name_unique" UNIQUE("folder_name")
);
--> statement-breakpoint
CREATE TABLE "project_environment_variable" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"key" text NOT NULL,
	"encrypted_value" text NOT NULL,
	"is_secret" boolean DEFAULT true NOT NULL,
	"is_required" boolean DEFAULT false NOT NULL,
	"has_value" boolean DEFAULT true NOT NULL,
	"description" text DEFAULT '',
	"created_by_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"inviter_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"token" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"responded_at" timestamp,
	CONSTRAINT "project_invitation_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "project_member" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"can_edit_files" boolean DEFAULT true NOT NULL,
	"can_manage_tickets" boolean DEFAULT true NOT NULL,
	"can_chat" boolean DEFAULT true NOT NULL,
	"can_invite_members" boolean DEFAULT false NOT NULL,
	"joined_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"invited_by_id" text
);
--> statement-breakpoint
CREATE TABLE "project" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"provided_name" text,
	"description" text,
	"owner_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"icon" text DEFAULT '📋' NOT NULL,
	"repo_url" text,
	"repo_owner" text,
	"repo_name" text,
	"stack" text DEFAULT '',
	"custom_project_dir" text,
	"custom_install_cmd" text,
	"custom_dev_cmd" text,
	"custom_default_port" integer,
	"linear_team_id" text,
	"linear_project_id" text,
	"linear_sync_enabled" boolean DEFAULT false NOT NULL,
	"ticket_counter" integer DEFAULT 0 NOT NULL,
	"preview_ticket_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "project_project_id_unique" UNIQUE("project_id")
);
--> statement-breakpoint
CREATE TABLE "project_ticket_attachment" (
	"id" text PRIMARY KEY NOT NULL,
	"ticket_id" text NOT NULL,
	"uploaded_by_id" text,
	"file_path" text NOT NULL,
	"original_filename" text DEFAULT '',
	"file_type" text DEFAULT '',
	"file_size" integer DEFAULT 0 NOT NULL,
	"uploaded_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_ticket" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"ticket_key" text,
	"name" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"stage_id" text,
	"description" text NOT NULL,
	"priority" text DEFAULT 'Medium' NOT NULL,
	"role" text DEFAULT 'user' NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb,
	"ui_requirements" jsonb DEFAULT '{}'::jsonb,
	"component_specs" jsonb DEFAULT '{}'::jsonb,
	"acceptance_criteria" jsonb DEFAULT '[]'::jsonb,
	"dependencies" jsonb DEFAULT '[]'::jsonb,
	"source_document_id" text,
	"conversation_id" text,
	"notes" text DEFAULT '',
	"execution_order" integer DEFAULT 0 NOT NULL,
	"complexity" text DEFAULT 'medium' NOT NULL,
	"requires_worktree" boolean DEFAULT true NOT NULL,
	"github_branch" text,
	"github_commit_sha" text,
	"github_pr_url" text,
	"github_pr_number" integer,
	"github_merge_status" text,
	"github_merge_commit_sha" text,
	"github_last_revert_sha" text,
	"github_reverted_at" timestamp,
	"github_reverted_by_id" text,
	"linear_issue_id" text,
	"linear_issue_url" text,
	"linear_state" text,
	"linear_priority" integer,
	"linear_assignee_id" text,
	"linear_synced_at" timestamp,
	"linear_sync_enabled" boolean DEFAULT true NOT NULL,
	"queue_status" text DEFAULT 'none' NOT NULL,
	"queued_at" timestamp,
	"queue_task_id" text,
	"execution_time_seconds" real DEFAULT 0 NOT NULL,
	"last_execution_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_todo_list" (
	"id" text PRIMARY KEY NOT NULL,
	"ticket_id" text NOT NULL,
	"description" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	"cli_task_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_log" (
	"id" text PRIMARY KEY NOT NULL,
	"ticket_id" text NOT NULL,
	"task_id" text,
	"log_type" text DEFAULT 'command' NOT NULL,
	"command" text NOT NULL,
	"explanation" text,
	"output" text,
	"exit_code" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_merge_history" (
	"id" text PRIMARY KEY NOT NULL,
	"ticket_id" text NOT NULL,
	"action" text NOT NULL,
	"merge_commit_sha" text NOT NULL,
	"revert_commit_sha" text,
	"performed_by_id" text,
	"files_changed" jsonb DEFAULT '[]'::jsonb,
	"lines_added" integer DEFAULT 0 NOT NULL,
	"lines_removed" integer DEFAULT 0 NOT NULL,
	"commit_message" text DEFAULT '',
	"commit_author" text DEFAULT '',
	"commit_date" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_stage" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT '#6366f1' NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_completed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_file_version" (
	"id" text PRIMARY KEY NOT NULL,
	"file_id" text NOT NULL,
	"version_number" integer NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"created_by_id" text,
	"change_description" text
);
--> statement-breakpoint
CREATE TABLE "project_file" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"file_type" text NOT NULL,
	"content" text,
	"s3_key" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_call_history" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"conversation_id" text,
	"message_id" text,
	"tool_name" text NOT NULL,
	"tool_input" jsonb DEFAULT '{}'::jsonb,
	"generated_content" text NOT NULL,
	"content_type" text DEFAULT 'text' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "design_canvas" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '',
	"is_default" boolean DEFAULT false NOT NULL,
	"feature_positions" jsonb DEFAULT '{}'::jsonb,
	"visible_features" jsonb DEFAULT '[]'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_design_feature" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"conversation_id" text,
	"feature_name" text NOT NULL,
	"feature_description" text DEFAULT '',
	"explainer" text DEFAULT '',
	"platform" text DEFAULT 'web' NOT NULL,
	"css_style" text DEFAULT '',
	"common_elements" jsonb DEFAULT '[]'::jsonb,
	"pages" jsonb DEFAULT '[]'::jsonb,
	"entry_page_id" text DEFAULT '',
	"feature_connections" jsonb DEFAULT '[]'::jsonb,
	"canvas_position" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_event" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_run_id" text NOT NULL,
	"ticket_execution_id" text,
	"event_type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb,
	"requires_user_action" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_run" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"trigger_message" text NOT NULL,
	"run_type" text DEFAULT 'direct_response' NOT NULL,
	"plan" jsonb DEFAULT '{}'::jsonb,
	"status" text DEFAULT 'planning' NOT NULL,
	"orchestrator_messages" jsonb DEFAULT '[]'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "ticket_execution_dependency" (
	"id" text PRIMARY KEY NOT NULL,
	"execution_id" text NOT NULL,
	"depends_on_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_execution" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_run_id" text NOT NULL,
	"ticket_id" text,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"execution_type" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"sequence_number" integer DEFAULT 0 NOT NULL,
	"worker_context" jsonb DEFAULT '{}'::jsonb,
	"result" jsonb,
	"blocked_reason" text,
	"blocked_question" text,
	"user_response" text,
	"task_id" text,
	"worker_type" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "token_usage" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"project_id" text,
	"conversation_id" text,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"total_tokens" integer DEFAULT 0 NOT NULL,
	"timestamp" timestamp DEFAULT now() NOT NULL,
	"request_id" text,
	"cost" real
);
--> statement-breakpoint
CREATE TABLE "sandbox" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text,
	"user_id" text,
	"ticket_id" text,
	"mags_workspace_id" text,
	"mags_job_id" text,
	"mags_base_workspace_id" text,
	"workspace_type" text DEFAULT 'ticket' NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"cli_session_id" text,
	"preview_url" text,
	"preview_port" integer,
	"current_branch" text,
	"output_offset" integer DEFAULT 0 NOT NULL,
	"tech_stack" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_mags_workspace_id_unique" UNIQUE("mags_workspace_id")
);
--> statement-breakpoint
CREATE TABLE "server_log" (
	"id" text PRIMARY KEY NOT NULL,
	"sandbox_id" text NOT NULL,
	"ticket_id" text,
	"level" text DEFAULT 'info' NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instant_app" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'gathering' NOT NULL,
	"requirements" text,
	"env_vars" jsonb DEFAULT '{}'::jsonb,
	"preview_url" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"project_id" text,
	"user_id" text NOT NULL,
	"sandbox_id" text,
	"conversation_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "instant_app_app_id_unique" UNIQUE("app_id")
);
--> statement-breakpoint
CREATE TABLE "project_activity" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"ticket_id" text,
	"actor_type" text DEFAULT 'system' NOT NULL,
	"activity_type" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_server" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"transport_type" text NOT NULL,
	"url" text NOT NULL,
	"headers" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_bot" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"bot_token" text NOT NULL,
	"bot_username" text,
	"project_id" text,
	"conversation_id" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_bot_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "share_link" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"project_id" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"created_by_id" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"expires_at" timestamp,
	"view_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "share_link_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "document_comment" (
	"id" text PRIMARY KEY NOT NULL,
	"file_id" text NOT NULL,
	"user_id" text NOT NULL,
	"selected_text" text NOT NULL,
	"range_start" integer NOT NULL,
	"range_end" integer NOT NULL,
	"content" text NOT NULL,
	"parent_id" text,
	"is_resolved" boolean DEFAULT false NOT NULL,
	"resolved_by_id" text,
	"resolved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "public_instant_chat" (
	"id" text PRIMARY KEY NOT NULL,
	"channel" text NOT NULL,
	"external_id" text NOT NULL,
	"conversation_id" text,
	"display_name" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_data_file" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"file_name" text NOT NULL,
	"file_type" text,
	"file_path" text,
	"s3_key" text,
	"file_size" integer,
	"description" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_message" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"conversation_type" text DEFAULT 'individual' NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_schedule" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"name" text NOT NULL,
	"cron_expression" text NOT NULL,
	"command" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"max_retries" integer DEFAULT 0 NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"last_run_at" timestamp,
	"next_run_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_secret" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"key" text NOT NULL,
	"value_encrypted" text NOT NULL,
	"description" text,
	"service" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_task_run" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"schedule_id" text,
	"trigger_type" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"prompt" text NOT NULL,
	"trigger_payload" jsonb,
	"started_at" timestamp,
	"finished_at" timestamp,
	"exit_code" integer,
	"output_summary" text,
	"error_message" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"parent_run_id" text,
	"timeout_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"personality" text,
	"instructions" text,
	"status" text DEFAULT 'idle' NOT NULL,
	"sandbox_id" text,
	"conversation_id" text,
	"composio_toolkits" jsonb DEFAULT '[]'::jsonb,
	"memory_content" text,
	"memory_last_synced_at" timestamp,
	"sandbox_url" text,
	"cli_session_id" text,
	"state" jsonb DEFAULT '{}'::jsonb,
	"webhook_token" text,
	"current_run_id" text,
	"auto_stop_after_idle_ms" integer,
	"last_activity_at" timestamp,
	"run_timeout_ms" integer,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_agent_id_unique" UNIQUE("agent_id")
);
--> statement-breakpoint
CREATE TABLE "composio_toolkit" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"toolkit" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"connected_account_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_state" ADD CONSTRAINT "application_state_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_verification_code" ADD CONSTRAINT "email_verification_code_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_verification_token" ADD CONSTRAINT "email_verification_token_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_services_api_key" ADD CONSTRAINT "external_services_api_key_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_token" ADD CONSTRAINT "github_token_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_api_key" ADD CONSTRAINT "llm_api_key_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile" ADD CONSTRAINT "profile_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_invitation" ADD CONSTRAINT "organization_invitation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_invitation" ADD CONSTRAINT "organization_invitation_inviter_id_user_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_membership" ADD CONSTRAINT "organization_membership_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_membership" ADD CONSTRAINT "organization_membership_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization" ADD CONSTRAINT "organization_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_role" ADD CONSTRAINT "agent_role_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_file" ADD CONSTRAINT "chat_file_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_file" ADD CONSTRAINT "chat_file_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_selection" ADD CONSTRAINT "model_selection_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_code_generation" ADD CONSTRAINT "project_code_generation_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_environment_variable" ADD CONSTRAINT "project_environment_variable_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_environment_variable" ADD CONSTRAINT "project_environment_variable_created_by_id_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_invitation" ADD CONSTRAINT "project_invitation_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_invitation" ADD CONSTRAINT "project_invitation_inviter_id_user_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_member" ADD CONSTRAINT "project_member_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_member" ADD CONSTRAINT "project_member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_member" ADD CONSTRAINT "project_member_invited_by_id_user_id_fk" FOREIGN KEY ("invited_by_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_ticket_attachment" ADD CONSTRAINT "project_ticket_attachment_ticket_id_project_ticket_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."project_ticket"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_ticket_attachment" ADD CONSTRAINT "project_ticket_attachment_uploaded_by_id_user_id_fk" FOREIGN KEY ("uploaded_by_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_ticket" ADD CONSTRAINT "project_ticket_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_ticket" ADD CONSTRAINT "project_ticket_stage_id_ticket_stage_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."ticket_stage"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_ticket" ADD CONSTRAINT "project_ticket_github_reverted_by_id_user_id_fk" FOREIGN KEY ("github_reverted_by_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_todo_list" ADD CONSTRAINT "project_todo_list_ticket_id_project_ticket_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."project_ticket"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_log" ADD CONSTRAINT "ticket_log_ticket_id_project_ticket_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."project_ticket"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_log" ADD CONSTRAINT "ticket_log_task_id_project_todo_list_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."project_todo_list"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_merge_history" ADD CONSTRAINT "ticket_merge_history_ticket_id_project_ticket_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."project_ticket"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_merge_history" ADD CONSTRAINT "ticket_merge_history_performed_by_id_user_id_fk" FOREIGN KEY ("performed_by_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_stage" ADD CONSTRAINT "ticket_stage_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_file_version" ADD CONSTRAINT "project_file_version_file_id_project_file_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."project_file"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_file_version" ADD CONSTRAINT "project_file_version_created_by_id_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_file" ADD CONSTRAINT "project_file_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_call_history" ADD CONSTRAINT "tool_call_history_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_canvas" ADD CONSTRAINT "design_canvas_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_design_feature" ADD CONSTRAINT "project_design_feature_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_event" ADD CONSTRAINT "agent_event_agent_run_id_agent_run_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_event" ADD CONSTRAINT "agent_event_ticket_execution_id_ticket_execution_id_fk" FOREIGN KEY ("ticket_execution_id") REFERENCES "public"."ticket_execution"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_execution_dependency" ADD CONSTRAINT "ticket_execution_dependency_execution_id_ticket_execution_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."ticket_execution"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_execution_dependency" ADD CONSTRAINT "ticket_execution_dependency_depends_on_id_ticket_execution_id_fk" FOREIGN KEY ("depends_on_id") REFERENCES "public"."ticket_execution"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_execution" ADD CONSTRAINT "ticket_execution_agent_run_id_agent_run_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_usage" ADD CONSTRAINT "token_usage_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox" ADD CONSTRAINT "sandbox_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox" ADD CONSTRAINT "sandbox_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox" ADD CONSTRAINT "sandbox_ticket_id_project_ticket_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."project_ticket"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_log" ADD CONSTRAINT "server_log_sandbox_id_sandbox_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."sandbox"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_log" ADD CONSTRAINT "server_log_ticket_id_project_ticket_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."project_ticket"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instant_app" ADD CONSTRAINT "instant_app_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instant_app" ADD CONSTRAINT "instant_app_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instant_app" ADD CONSTRAINT "instant_app_sandbox_id_sandbox_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."sandbox"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instant_app" ADD CONSTRAINT "instant_app_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_activity" ADD CONSTRAINT "project_activity_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_server" ADD CONSTRAINT "mcp_server_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_bot" ADD CONSTRAINT "telegram_bot_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_link" ADD CONSTRAINT "share_link_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_link" ADD CONSTRAINT "share_link_created_by_id_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_comment" ADD CONSTRAINT "document_comment_file_id_project_file_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."project_file"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_comment" ADD CONSTRAINT "document_comment_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_comment" ADD CONSTRAINT "document_comment_resolved_by_id_user_id_fk" FOREIGN KEY ("resolved_by_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_instant_chat" ADD CONSTRAINT "public_instant_chat_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_data_file" ADD CONSTRAINT "agent_data_file_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_message" ADD CONSTRAINT "agent_message_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_schedule" ADD CONSTRAINT "agent_schedule_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_secret" ADD CONSTRAINT "agent_secret_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_task_run" ADD CONSTRAINT "agent_task_run_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_task_run" ADD CONSTRAINT "agent_task_run_schedule_id_agent_schedule_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."agent_schedule"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_sandbox_id_sandbox_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."sandbox"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "composio_toolkit" ADD CONSTRAINT "composio_toolkit_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "evc_user_idx" ON "email_verification_code" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "evt_user_idx" ON "email_verification_token" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "org_invite_unique" ON "organization_invitation" USING btree ("organization_id","email");--> statement-breakpoint
CREATE INDEX "org_invite_org_idx" ON "organization_invitation" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "org_member_unique" ON "organization_membership" USING btree ("user_id","organization_id");--> statement-breakpoint
CREATE INDEX "org_member_org_idx" ON "organization_membership" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "org_owner_idx" ON "organization" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "chatfile_conv_idx" ON "chat_file" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "conv_user_idx" ON "conversation" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "conv_project_idx" ON "conversation" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "msg_conv_created_idx" ON "message" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "msg_conv_partial_idx" ON "message" USING btree ("conversation_id","is_partial");--> statement-breakpoint
CREATE UNIQUE INDEX "pev_project_key_unique" ON "project_environment_variable" USING btree ("project_id","key");--> statement-breakpoint
CREATE INDEX "pev_project_idx" ON "project_environment_variable" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pi_project_email_unique" ON "project_invitation" USING btree ("project_id","email");--> statement-breakpoint
CREATE INDEX "pi_project_idx" ON "project_invitation" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pm_project_user_unique" ON "project_member" USING btree ("project_id","user_id");--> statement-breakpoint
CREATE INDEX "pm_project_idx" ON "project_member" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_owner_idx" ON "project" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "pta_ticket_idx" ON "project_ticket_attachment" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "pt_project_idx" ON "project_ticket" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "pt_stage_idx" ON "project_ticket" USING btree ("stage_id");--> statement-breakpoint
CREATE INDEX "pt_conv_idx" ON "project_ticket" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pt_project_key_unique" ON "project_ticket" USING btree ("project_id","ticket_key");--> statement-breakpoint
CREATE INDEX "ptl_ticket_idx" ON "project_todo_list" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "tl_ticket_idx" ON "ticket_log" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "tl_task_idx" ON "ticket_log" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "tl_type_idx" ON "ticket_log" USING btree ("log_type");--> statement-breakpoint
CREATE INDEX "tmh_ticket_idx" ON "ticket_merge_history" USING btree ("ticket_id","created_at");--> statement-breakpoint
CREATE INDEX "tmh_sha_idx" ON "ticket_merge_history" USING btree ("merge_commit_sha");--> statement-breakpoint
CREATE UNIQUE INDEX "ts_project_name_unique" ON "ticket_stage" USING btree ("project_id","name");--> statement-breakpoint
CREATE INDEX "ts_project_order_idx" ON "ticket_stage" USING btree ("project_id","order");--> statement-breakpoint
CREATE UNIQUE INDEX "pfv_file_version_unique" ON "project_file_version" USING btree ("file_id","version_number");--> statement-breakpoint
CREATE INDEX "pfv_file_idx" ON "project_file_version" USING btree ("file_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pf_project_name_type_unique" ON "project_file" USING btree ("project_id","name","file_type");--> statement-breakpoint
CREATE INDEX "pf_project_type_idx" ON "project_file" USING btree ("project_id","file_type");--> statement-breakpoint
CREATE INDEX "tch_project_idx" ON "tool_call_history" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "tch_project_tool_idx" ON "tool_call_history" USING btree ("project_id","tool_name");--> statement-breakpoint
CREATE INDEX "tch_conv_idx" ON "tool_call_history" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dc_project_name_unique" ON "design_canvas" USING btree ("project_id","name");--> statement-breakpoint
CREATE INDEX "dc_project_idx" ON "design_canvas" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "dc_project_default_idx" ON "design_canvas" USING btree ("project_id","is_default");--> statement-breakpoint
CREATE UNIQUE INDEX "pdf_project_name_unique" ON "project_design_feature" USING btree ("project_id","feature_name");--> statement-breakpoint
CREATE INDEX "pdf_project_idx" ON "project_design_feature" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "ae_run_type_idx" ON "agent_event" USING btree ("agent_run_id","event_type");--> statement-breakpoint
CREATE INDEX "ae_user_action_idx" ON "agent_event" USING btree ("requires_user_action","created_at");--> statement-breakpoint
CREATE INDEX "ar_conv_status_idx" ON "agent_run" USING btree ("conversation_id","status");--> statement-breakpoint
CREATE INDEX "ar_project_status_idx" ON "agent_run" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "ted_exec_idx" ON "ticket_execution_dependency" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX "te_run_status_idx" ON "ticket_execution" USING btree ("agent_run_id","status");--> statement-breakpoint
CREATE INDEX "te_status_seq_idx" ON "ticket_execution" USING btree ("status","sequence_number");--> statement-breakpoint
CREATE INDEX "tu_user_ts_idx" ON "token_usage" USING btree ("user_id","timestamp");--> statement-breakpoint
CREATE INDEX "tu_project_ts_idx" ON "token_usage" USING btree ("project_id","timestamp");--> statement-breakpoint
CREATE INDEX "tu_conv_ts_idx" ON "token_usage" USING btree ("conversation_id","timestamp");--> statement-breakpoint
CREATE INDEX "tu_provider_model_idx" ON "token_usage" USING btree ("provider","model");--> statement-breakpoint
CREATE INDEX "sb_project_idx" ON "sandbox" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "sb_ticket_idx" ON "sandbox" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "sb_user_idx" ON "sandbox" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sb_mags_ws_idx" ON "sandbox" USING btree ("mags_workspace_id");--> statement-breakpoint
CREATE INDEX "sl_sandbox_idx" ON "server_log" USING btree ("sandbox_id","created_at");--> statement-breakpoint
CREATE INDEX "sl_ticket_idx" ON "server_log" USING btree ("ticket_id","created_at");--> statement-breakpoint
CREATE INDEX "instant_user_idx" ON "instant_app" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "instant_project_idx" ON "instant_app" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "instant_status_idx" ON "instant_app" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "instant_app_id_unique" ON "instant_app" USING btree ("app_id");--> statement-breakpoint
CREATE UNIQUE INDEX "instant_sandbox_unique" ON "instant_app" USING btree ("sandbox_id");--> statement-breakpoint
CREATE UNIQUE INDEX "instant_conversation_unique" ON "instant_app" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "pa_project_created_idx" ON "project_activity" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "pa_ticket_idx" ON "project_activity" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "pa_activity_type_idx" ON "project_activity" USING btree ("activity_type");--> statement-breakpoint
CREATE INDEX "sl_project_idx" ON "share_link" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "sl_token_idx" ON "share_link" USING btree ("token");--> statement-breakpoint
CREATE INDEX "dc_file_idx" ON "document_comment" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "dc_parent_idx" ON "document_comment" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "dc_user_idx" ON "document_comment" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "public_instant_channel_ext_idx" ON "public_instant_chat" USING btree ("channel","external_id");--> statement-breakpoint
CREATE INDEX "public_instant_conversation_idx" ON "public_instant_chat" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "adf_agent_idx" ON "agent_data_file" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "am_agent_idx" ON "agent_message" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "am_type_idx" ON "agent_message" USING btree ("conversation_type");--> statement-breakpoint
CREATE INDEX "as_agent_idx" ON "agent_schedule" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "asec_agent_idx" ON "agent_secret" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "asec_agent_key_uq" ON "agent_secret" USING btree ("agent_id","key");--> statement-breakpoint
CREATE INDEX "atr_agent_idx" ON "agent_task_run" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "atr_status_idx" ON "agent_task_run" USING btree ("status");--> statement-breakpoint
CREATE INDEX "atr_schedule_idx" ON "agent_task_run" USING btree ("schedule_id");--> statement-breakpoint
CREATE INDEX "agent_user_idx" ON "agent" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "agent_status_idx" ON "agent" USING btree ("status");--> statement-breakpoint
CREATE INDEX "agent_webhook_token_idx" ON "agent" USING btree ("webhook_token");