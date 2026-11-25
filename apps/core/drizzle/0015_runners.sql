CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"runner_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"state" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"branch" text,
	"error" text,
	"usage" jsonb,
	CONSTRAINT "agent_runs_state_check" CHECK ("agent_runs"."state" in ('running', 'succeeded', 'failed', 'expired', 'parked', 'released'))
);
--> statement-breakpoint
CREATE TABLE "runner_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"allow_personal_unattended" boolean DEFAULT false NOT NULL,
	CONSTRAINT "runner_settings_single_row" CHECK ("runner_settings"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "runners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"account_type" text NOT NULL,
	"capabilities" text[] NOT NULL,
	"mode" text NOT NULL,
	"max_concurrent" integer DEFAULT 1 NOT NULL,
	"working_hours" jsonb,
	"paused" boolean DEFAULT false NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runners_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "runners_kind_check" CHECK ("runners"."kind" in ('server', 'dev-machine')),
	CONSTRAINT "runners_account_type_check" CHECK ("runners"."account_type" in ('api-key', 'org-plan', 'personal-subscription')),
	CONSTRAINT "runners_mode_check" CHECK ("runners"."mode" in ('on-demand', 'unattended')),
	CONSTRAINT "runners_capabilities_check" CHECK (cardinality("runners"."capabilities") > 0 and "runners"."capabilities" <@ array['analyze-repo', 'code-change', 'run-tests']::text[]),
	CONSTRAINT "runners_max_concurrent_check" CHECK ("runners"."max_concurrent" between 1 and 4)
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "parked_discussion_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_owner_id_people_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_owner_id_people_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_created_by_people_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_one_running" ON "agent_runs" USING btree ("task_id") WHERE "agent_runs"."state" = 'running';--> statement-breakpoint
CREATE INDEX "agent_runs_runner_state_idx" ON "agent_runs" USING btree ("runner_id","state");--> statement-breakpoint
CREATE INDEX "runners_owner_idx" ON "runners" USING btree ("owner_id");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parked_discussion_id_discussions_id_fk" FOREIGN KEY ("parked_discussion_id") REFERENCES "public"."discussions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
INSERT INTO "runner_settings" ("id") VALUES (1) ON CONFLICT DO NOTHING;
