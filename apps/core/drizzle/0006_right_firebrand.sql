CREATE TABLE "conversation_reads" (
	"conversation_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"last_read_seq" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "conversation_reads_conversation_id_person_id_pk" PRIMARY KEY("conversation_id","person_id")
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"project_id" uuid,
	"work_item_id" uuid,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_message_at" timestamp with time zone,
	CONSTRAINT "conversations_kind_check" CHECK ("conversations"."kind" in ('personal', 'project', 'work_item', 'intake')),
	CONSTRAINT "conversations_scope_ids_check" CHECK (("conversations"."kind" in ('personal', 'intake'))
        OR ("conversations"."kind" = 'project' AND "conversations"."project_id" IS NOT NULL AND "conversations"."work_item_id" IS NULL)
        OR ("conversations"."kind" = 'work_item' AND "conversations"."project_id" IS NOT NULL AND "conversations"."work_item_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"seq" bigserial NOT NULL,
	"author_kind" text NOT NULL,
	"author_id" uuid,
	"text" text NOT NULL,
	"attachment_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "messages_author_kind_check" CHECK ("messages"."author_kind" in ('person', 'ai', 'system'))
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"link" text,
	"dedupe_key" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_kind_check" CHECK ("notifications"."kind" in ('task_assigned', 'proposal_pending', 'request_update', 'work_item_stuck', 'secretary_message'))
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"work_item_id" uuid,
	"kind" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_by_kind" text NOT NULL,
	"on_behalf_of" uuid,
	"decided_by" uuid,
	"decision_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "proposals_kind_check" CHECK ("proposals"."kind" in ('step_advance', 'create_work_item', 'priority_change')),
	CONSTRAINT "proposals_state_check" CHECK ("proposals"."state" in ('pending', 'accepted', 'rejected', 'superseded')),
	CONSTRAINT "proposals_created_by_kind_check" CHECK ("proposals"."created_by_kind" in ('person', 'system', 'ai'))
);
--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_role_check";--> statement-breakpoint
ALTER TABLE "attachments" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "conversation_id" uuid;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "requester_id" uuid;--> statement-breakpoint
ALTER TABLE "conversation_reads" ADD CONSTRAINT "conversation_reads_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_reads" ADD CONSTRAINT "conversation_reads_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_owner_id_people_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_author_id_people_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_on_behalf_of_people_id_fk" FOREIGN KEY ("on_behalf_of") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_decided_by_people_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_one_personal" ON "conversations" USING btree ("owner_id") WHERE "conversations"."kind" = 'personal';--> statement-breakpoint
CREATE INDEX "messages_conversation_seq_idx" ON "messages" USING btree ("conversation_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_dedupe_unique" ON "notifications" USING btree ("person_id","dedupe_key") WHERE "notifications"."dedupe_key" is not null;--> statement-breakpoint
CREATE INDEX "notifications_person_read_idx" ON "notifications" USING btree ("person_id","read_at","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "proposals_one_pending_step_advance" ON "proposals" USING btree ("work_item_id","kind") WHERE "proposals"."state" = 'pending' and "proposals"."kind" = 'step_advance';--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_requester_id_people_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_owner_check" CHECK ("attachments"."project_id" is not null or "attachments"."conversation_id" is not null);--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_role_check" CHECK ("tasks"."role" in ('PM', 'BA', 'SA', 'DEV', 'QC', 'REQUESTER'));