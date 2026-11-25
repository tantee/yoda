CREATE TABLE "gitlab_deliveries" (
	"event_uuid" text PRIMARY KEY NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gitlab_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"last_webhook_at" timestamp with time zone,
	CONSTRAINT "gitlab_settings_single_row" CHECK ("gitlab_settings"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "merge_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"mr_iid" integer NOT NULL,
	"work_item_id" uuid,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"state" text NOT NULL,
	"source_branch" text NOT NULL,
	"pipeline" text DEFAULT 'none' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merge_requests_repo_iid_unique" UNIQUE("repo_id","mr_iid"),
	CONSTRAINT "merge_requests_state_check" CHECK ("merge_requests"."state" in ('opened', 'merged', 'closed')),
	CONSTRAINT "merge_requests_pipeline_check" CHECK ("merge_requests"."pipeline" in ('none', 'pending', 'running', 'success', 'failed', 'canceled'))
);
--> statement-breakpoint
CREATE TABLE "project_repos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"gitlab_project_id" integer NOT NULL,
	"path_with_namespace" text NOT NULL,
	"web_url" text NOT NULL,
	"default_branch" text NOT NULL,
	"added_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_repos_project_gitlab_unique" UNIQUE("project_id","gitlab_project_id")
);
--> statement-breakpoint
CREATE TABLE "work_item_repos" (
	"work_item_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"issue_iid" integer,
	"issue_url" text,
	"section_hash" text,
	"sync_status" text DEFAULT 'pending' NOT NULL,
	"sync_error" text,
	"last_synced_at" timestamp with time zone,
	CONSTRAINT "work_item_repos_work_item_id_repo_id_pk" PRIMARY KEY("work_item_id","repo_id"),
	CONSTRAINT "work_item_repos_sync_status_check" CHECK ("work_item_repos"."sync_status" in ('pending', 'synced', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "knowledge_entries" DROP CONSTRAINT "knowledge_entries_source_kind_check";--> statement-breakpoint
ALTER TABLE "merge_requests" ADD CONSTRAINT "merge_requests_repo_id_project_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."project_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_requests" ADD CONSTRAINT "merge_requests_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_repos" ADD CONSTRAINT "project_repos_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_repos" ADD CONSTRAINT "project_repos_added_by_people_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_item_repos" ADD CONSTRAINT "work_item_repos_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_item_repos" ADD CONSTRAINT "work_item_repos_repo_id_project_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."project_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_entries" ADD CONSTRAINT "knowledge_entries_source_kind_check" CHECK ("knowledge_entries"."source_kind" in ('person', 'ai', 'upload', 'task', 'gitlab'));
--> statement-breakpoint
INSERT INTO "gitlab_settings" ("id") VALUES (1) ON CONFLICT DO NOTHING;
