CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TABLE "people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"keycloak_sub" text NOT NULL,
	"username" text NOT NULL,
	"display_name" text NOT NULL,
	"email" text,
	"is_admin" boolean DEFAULT false NOT NULL,
	"staff_override" boolean,
	"skills" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"last_seen_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "people_keycloak_sub_unique" UNIQUE("keycloak_sub")
);
--> statement-breakpoint
CREATE TABLE "project_members" (
	"project_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"roles" text[] NOT NULL,
	CONSTRAINT "project_members_project_id_person_id_pk" PRIMARY KEY("project_id","person_id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"no_ai" boolean DEFAULT false NOT NULL,
	"autonomy" text DEFAULT 'propose' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "projects_status_check" CHECK ("projects"."status" in ('active', 'archived')),
	CONSTRAINT "projects_autonomy_check" CHECK ("projects"."autonomy" in ('propose', 'auto-assign'))
);
--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_people_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;