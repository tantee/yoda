CREATE TABLE "channel_link_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel" text NOT NULL,
	"external_id" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_link_attempts_channel_check" CHECK ("channel_link_attempts"."channel" in ('line', 'telegram'))
);
--> statement-breakpoint
CREATE INDEX "channel_link_attempts_channel_at_idx" ON "channel_link_attempts" USING btree ("channel","at");--> statement-breakpoint
CREATE INDEX "channel_link_attempts_external_idx" ON "channel_link_attempts" USING btree ("channel","external_id","at");