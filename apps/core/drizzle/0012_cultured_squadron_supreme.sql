CREATE TABLE "agendas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"meeting_at" timestamp with time zone NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discussion_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"discussion_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"option_key" text,
	"text" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discussion_responses_kind_check" CHECK ("discussion_responses"."kind" in ('opinion', 'vote'))
);
--> statement-breakpoint
CREATE TABLE "discussions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"work_item_id" uuid,
	"task_id" uuid,
	"step_key" text,
	"question" text NOT NULL,
	"details" text DEFAULT '' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"brief" jsonb,
	"raised_by" uuid NOT NULL,
	"decision" text,
	"decided_option_key" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"agenda_id" uuid,
	"agenda_position" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discussions_state_check" CHECK ("discussions"."state" in ('open', 'scheduled', 'decided', 'withdrawn')),
	CONSTRAINT "discussions_priority_check" CHECK ("discussions"."priority" in ('low', 'normal', 'high', 'urgent'))
);
--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_kind_check";--> statement-breakpoint
ALTER TABLE "proposals" DROP CONSTRAINT "proposals_kind_check";--> statement-breakpoint
ALTER TABLE "agendas" ADD CONSTRAINT "agendas_created_by_people_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discussion_responses" ADD CONSTRAINT "discussion_responses_discussion_id_discussions_id_fk" FOREIGN KEY ("discussion_id") REFERENCES "public"."discussions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discussion_responses" ADD CONSTRAINT "discussion_responses_author_id_people_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discussions" ADD CONSTRAINT "discussions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discussions" ADD CONSTRAINT "discussions_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discussions" ADD CONSTRAINT "discussions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discussions" ADD CONSTRAINT "discussions_raised_by_people_id_fk" FOREIGN KEY ("raised_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discussions" ADD CONSTRAINT "discussions_decided_by_people_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discussions" ADD CONSTRAINT "discussions_agenda_id_agendas_id_fk" FOREIGN KEY ("agenda_id") REFERENCES "public"."agendas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "discussion_responses_one_vote" ON "discussion_responses" USING btree ("discussion_id","author_id") WHERE "discussion_responses"."kind" = 'vote';--> statement-breakpoint
CREATE INDEX "discussions_work_item_state_idx" ON "discussions" USING btree ("work_item_id","state");--> statement-breakpoint
CREATE INDEX "discussions_project_state_idx" ON "discussions" USING btree ("project_id","state");--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_kind_check" CHECK ("notifications"."kind" in ('task_assigned', 'proposal_pending', 'request_update', 'work_item_stuck', 'secretary_message', 'budget_alert', 'discussion'));--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_kind_check" CHECK ("proposals"."kind" in ('step_advance', 'create_work_item', 'priority_change', 'raise_discussion'));