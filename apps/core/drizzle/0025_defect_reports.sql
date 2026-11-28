CREATE TABLE "defect_reports" (
	"work_item_id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"steps" jsonb NOT NULL,
	"expected" text DEFAULT '' NOT NULL,
	"actual" text DEFAULT '' NOT NULL,
	"page_url" text NOT NULL,
	"page_title" text DEFAULT '' NOT NULL,
	"route" text,
	"build" jsonb,
	"backend_builds" jsonb NOT NULL,
	"client" jsonb NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"reported_by" uuid NOT NULL,
	"source" text DEFAULT 'extension' NOT NULL,
	"extension_version" text,
	"grant_id" uuid,
	"production_site" boolean DEFAULT false NOT NULL,
	"text_may_contain_patient_data" boolean DEFAULT false NOT NULL,
	"sensitive" boolean NOT NULL,
	"idempotency_key" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "defect_reports_idempotency" UNIQUE("reported_by","idempotency_key"),
	CONSTRAINT "defect_reports_kind_check" CHECK ("defect_reports"."kind" in ('defect', 'bug_fix_request')),
	CONSTRAINT "defect_reports_severity_check" CHECK ("defect_reports"."severity" in ('blocker', 'critical', 'major', 'minor', 'trivial')),
	CONSTRAINT "defect_reports_source_check" CHECK ("defect_reports"."source" in ('extension', 'portal'))
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "role" text;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "purged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "defect_reports" ADD CONSTRAINT "defect_reports_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "defect_reports" ADD CONSTRAINT "defect_reports_reported_by_people_id_fk" FOREIGN KEY ("reported_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "defect_reports" ADD CONSTRAINT "defect_reports_grant_id_extension_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."extension_grants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_role_check" CHECK ("attachments"."role" in ('screenshot', 'screenshot_full', 'video', 'buffer', 'console', 'network'));