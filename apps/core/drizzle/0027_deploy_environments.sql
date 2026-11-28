CREATE TABLE "deploy_environments" (
	"repo_id" uuid NOT NULL,
	"name" text NOT NULL,
	"external_url" text,
	"tier" text,
	"ref" text,
	"sha" text,
	"status" text,
	"deployed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deploy_environments_repo_id_name_pk" PRIMARY KEY("repo_id","name")
);
--> statement-breakpoint
ALTER TABLE "deploy_environments" ADD CONSTRAINT "deploy_environments_repo_id_project_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."project_repos"("id") ON DELETE cascade ON UPDATE no action;