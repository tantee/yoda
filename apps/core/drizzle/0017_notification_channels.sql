CREATE TABLE "channel_link_codes" (
	"code" text PRIMARY KEY NOT NULL,
	"person_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "channel_link_codes_channel_check" CHECK ("channel_link_codes"."channel" in ('line', 'telegram'))
);
--> statement-breakpoint
CREATE TABLE "channel_links" (
	"person_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"external_id" text NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_links_person_id_channel_pk" PRIMARY KEY("person_id","channel"),
	CONSTRAINT "channel_links_external_unique" UNIQUE("channel","external_id"),
	CONSTRAINT "channel_links_channel_check" CHECK ("channel_links"."channel" in ('line', 'telegram'))
);
--> statement-breakpoint
CREATE TABLE "notification_channel_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"email_enabled" boolean DEFAULT false NOT NULL,
	"line_enabled" boolean DEFAULT false NOT NULL,
	"telegram_enabled" boolean DEFAULT false NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_channel_settings_single_row" CHECK ("notification_channel_settings"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"notification_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"state" text NOT NULL,
	"error_code" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_deliveries_notification_id_channel_pk" PRIMARY KEY("notification_id","channel"),
	CONSTRAINT "notification_deliveries_channel_check" CHECK ("notification_deliveries"."channel" in ('email', 'line', 'telegram')),
	CONSTRAINT "notification_deliveries_state_check" CHECK ("notification_deliveries"."state" in ('sent', 'failed', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "notification_prefs" (
	"person_id" uuid PRIMARY KEY NOT NULL,
	"kinds" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channel_link_codes" ADD CONSTRAINT "channel_link_codes_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_links" ADD CONSTRAINT "channel_links_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_channel_settings" ADD CONSTRAINT "notification_channel_settings_updated_by_people_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_prefs" ADD CONSTRAINT "notification_prefs_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_link_codes_person_idx" ON "channel_link_codes" USING btree ("person_id","channel");--> statement-breakpoint
INSERT INTO "notification_channel_settings" ("id") VALUES (1) ON CONFLICT DO NOTHING;