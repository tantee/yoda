CREATE TABLE "department_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"ai_budget_usd" numeric(12, 2),
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "department_settings_single_row" CHECK ("department_settings"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "department_settings" ADD CONSTRAINT "department_settings_updated_by_people_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
INSERT INTO "department_settings" ("id") VALUES (1) ON CONFLICT DO NOTHING;