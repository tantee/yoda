CREATE TABLE "ai_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"task_id" uuid,
	"job" text NOT NULL,
	"provider" text,
	"model" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd" numeric(12, 6),
	"ok" boolean NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"work_item_id" uuid,
	"task_id" uuid,
	"storage_key" text NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"no_ai" boolean DEFAULT false NOT NULL,
	"extracted_text" text,
	"uploaded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachments_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
CREATE TABLE "knowledge_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_id" uuid NOT NULL,
	"idx" integer NOT NULL,
	"text" text NOT NULL,
	"embedding" vector(1024),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_chunks_entry_idx_unique" UNIQUE("entry_id","idx")
);
--> statement-breakpoint
CREATE TABLE "knowledge_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lineage_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"scope" text NOT NULL,
	"project_id" uuid,
	"work_item_id" uuid,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"status" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_ref" text,
	"no_ai" boolean DEFAULT false NOT NULL,
	"attachment_id" uuid,
	"created_by" uuid,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_entries_lineage_version_unique" UNIQUE("lineage_id","version"),
	CONSTRAINT "knowledge_entries_scope_check" CHECK ("knowledge_entries"."scope" in ('department', 'project', 'work_item')),
	CONSTRAINT "knowledge_entries_type_check" CHECK ("knowledge_entries"."type" in ('fact', 'decision', 'document', 'progress', 'memory')),
	CONSTRAINT "knowledge_entries_status_check" CHECK ("knowledge_entries"."status" in ('draft', 'confirmed')),
	CONSTRAINT "knowledge_entries_source_kind_check" CHECK ("knowledge_entries"."source_kind" in ('person', 'ai', 'upload', 'task')),
	CONSTRAINT "knowledge_entries_scope_ids_check" CHECK (("knowledge_entries"."scope" = 'department' AND "knowledge_entries"."project_id" IS NULL AND "knowledge_entries"."work_item_id" IS NULL)
        OR ("knowledge_entries"."scope" = 'project' AND "knowledge_entries"."project_id" IS NOT NULL AND "knowledge_entries"."work_item_id" IS NULL)
        OR ("knowledge_entries"."scope" = 'work_item' AND "knowledge_entries"."project_id" IS NOT NULL AND "knowledge_entries"."work_item_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "actor_kind" text DEFAULT 'person' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "ai_budget_usd" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "ai_calls" ADD CONSTRAINT "ai_calls_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_calls" ADD CONSTRAINT "ai_calls_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploaded_by_people_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_entry_id_knowledge_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."knowledge_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_entries" ADD CONSTRAINT "knowledge_entries_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_entries" ADD CONSTRAINT "knowledge_entries_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_entries" ADD CONSTRAINT "knowledge_entries_attachment_id_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_entries" ADD CONSTRAINT "knowledge_entries_created_by_people_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_calls_project_created_idx" ON "ai_calls" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_embedding_hnsw_idx" ON "knowledge_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "knowledge_chunks_text_trgm_idx" ON "knowledge_chunks" USING gin ("text" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_entries_one_live_version" ON "knowledge_entries" USING btree ("lineage_id") WHERE "knowledge_entries"."superseded_at" is null;--> statement-breakpoint
CREATE INDEX "knowledge_entries_title_trgm_idx" ON "knowledge_entries" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "knowledge_entries_body_trgm_idx" ON "knowledge_entries" USING gin ("body" gin_trgm_ops);--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_actor_kind_check" CHECK ("events"."actor_kind" in ('person', 'system', 'ai'));--> statement-breakpoint
UPDATE "events" SET "actor_kind" = 'system' WHERE "actor_id" IS NULL;
