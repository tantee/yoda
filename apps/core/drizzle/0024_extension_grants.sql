CREATE TABLE "extension_auth_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"person_id" uuid NOT NULL,
	"extension_id" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"browser_label" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "extension_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"extension_id" text NOT NULL,
	"browser_label" text NOT NULL,
	"access_hash" text,
	"access_expires_at" timestamp with time zone,
	"family_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"idle_expires_at" timestamp with time zone NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"last_ip" text,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"revoke_reason" text,
	CONSTRAINT "extension_grants_access_hash_unique" UNIQUE("access_hash"),
	CONSTRAINT "extension_grants_revoke_reason_check" CHECK ("extension_grants"."revoke_reason" in ('user', 'admin', 'admin_all', 'reuse_detected', 'extension_not_allowed', 'not_staff'))
);
--> statement-breakpoint
CREATE TABLE "extension_refresh_tokens" (
	"hash" text PRIMARY KEY NOT NULL,
	"grant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "extension_auth_codes" ADD CONSTRAINT "extension_auth_codes_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_grants" ADD CONSTRAINT "extension_grants_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_grants" ADD CONSTRAINT "extension_grants_revoked_by_people_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_refresh_tokens" ADD CONSTRAINT "extension_refresh_tokens_grant_id_extension_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."extension_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "extension_grants_person" ON "extension_grants" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "extension_refresh_tokens_grant" ON "extension_refresh_tokens" USING btree ("grant_id");