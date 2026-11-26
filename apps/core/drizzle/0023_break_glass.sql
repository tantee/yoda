CREATE TABLE "local_admins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"totp_secret" "bytea",
	"totp_key_id" text,
	"totp_enabled" boolean DEFAULT false NOT NULL,
	"totp_last_step" bigint,
	"must_change_password" boolean DEFAULT false NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"password_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "local_admins_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "local_recovery_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_id" uuid NOT NULL,
	"code_hash" "bytea" NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "local_sessions" (
	"id_hash" "bytea" PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"admin_id" uuid,
	"ua_hash" "bytea",
	"ip" "inet",
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "local_sessions_kind_check" CHECK ("local_sessions"."kind" in ('setup', 'recovery'))
);
--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_kind_check";--> statement-breakpoint
ALTER TABLE "setup_state" ADD COLUMN "setup_token_hash" "bytea";--> statement-breakpoint
ALTER TABLE "setup_state" ADD COLUMN "setup_token_expires" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "setup_state" ADD COLUMN "oidc_pending" jsonb;--> statement-breakpoint
ALTER TABLE "setup_state" ADD COLUMN "oidc_rollback" jsonb;--> statement-breakpoint
ALTER TABLE "local_recovery_codes" ADD CONSTRAINT "local_recovery_codes_admin_id_local_admins_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."local_admins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_sessions" ADD CONSTRAINT "local_sessions_admin_id_local_admins_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."local_admins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "local_recovery_codes_hash" ON "local_recovery_codes" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "local_sessions_expires" ON "local_sessions" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_kind_check" CHECK ("notifications"."kind" in ('task_assigned', 'proposal_pending', 'request_update', 'work_item_stuck', 'secretary_message', 'budget_alert', 'discussion', 'security_alert'));