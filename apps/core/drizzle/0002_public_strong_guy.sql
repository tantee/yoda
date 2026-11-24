UPDATE "people" SET "created_at" = now() WHERE "created_at" IS NULL;--> statement-breakpoint
UPDATE "people" SET "last_seen_at" = now() WHERE "last_seen_at" IS NULL;--> statement-breakpoint
UPDATE "projects" SET "created_at" = now() WHERE "created_at" IS NULL;--> statement-breakpoint
ALTER TABLE "people" ALTER COLUMN "created_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "people" ALTER COLUMN "last_seen_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "created_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_roles_check" CHECK (cardinality("project_members"."roles") > 0 AND "project_members"."roles" <@ ARRAY['PM','BA','SA','DEV','QC']::text[]);