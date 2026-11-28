CREATE TABLE "project_app_urls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"pattern" text NOT NULL,
	"environment" text,
	"production" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_app_urls_pattern" UNIQUE("project_id","pattern")
);
--> statement-breakpoint
ALTER TABLE "project_app_urls" ADD CONSTRAINT "project_app_urls_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_app_urls" ADD CONSTRAINT "project_app_urls_created_by_people_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;