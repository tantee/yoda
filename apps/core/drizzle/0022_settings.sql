CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb,
	"key_id" text,
	"wrapped_dek" "bytea",
	"dek_nonce" "bytea",
	"nonce" "bytea",
	"ciphertext" "bytea",
	"hint" text,
	"source" text NOT NULL,
	"pending" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid,
	"updated_by_label" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settings_value_or_secret" CHECK ("settings"."value" is null or "settings"."ciphertext" is null),
	CONSTRAINT "settings_secret_complete" CHECK (("settings"."ciphertext" is null) = ("settings"."key_id" is null) and ("settings"."ciphertext" is null) = ("settings"."wrapped_dek" is null) and ("settings"."ciphertext" is null) = ("settings"."dek_nonce" is null) and ("settings"."ciphertext" is null) = ("settings"."nonce" is null)),
	CONSTRAINT "settings_source_check" CHECK ("settings"."source" in ('ui', 'setup', 'env', 'import', 'cli', 'recovery', 'upgrade'))
);
--> statement-breakpoint
CREATE TABLE "settings_audit" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_person" uuid,
	"actor_label" text NOT NULL,
	"source" text NOT NULL,
	"action" text NOT NULL,
	"key" text,
	"old_value" jsonb,
	"new_value" jsonb,
	"old_fp" text,
	"new_fp" text,
	"result" text,
	"ip" "inet",
	"request_id" text
);
--> statement-breakpoint
CREATE TABLE "setup_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"install_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"setup_completed_at" timestamp with time zone,
	"setup_completed_by" uuid,
	"setup_completed_source" text,
	"setup_progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"key_canary" "bytea",
	"key_canary_key_id" text,
	"recovery_mode" boolean DEFAULT false NOT NULL,
	CONSTRAINT "setup_state_single_row" CHECK ("setup_state"."id" = 1),
	CONSTRAINT "setup_state_source_check" CHECK ("setup_state"."setup_completed_source" is null or "setup_state"."setup_completed_source" in ('setup', 'upgrade'))
);
--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_updated_by_people_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings_audit" ADD CONSTRAINT "settings_audit_actor_person_people_id_fk" FOREIGN KEY ("actor_person") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setup_state" ADD CONSTRAINT "setup_state_setup_completed_by_people_id_fk" FOREIGN KEY ("setup_completed_by") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "settings_audit_key_at" ON "settings_audit" USING btree ("key","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "settings_audit_at" ON "settings_audit" USING btree ("at" DESC NULLS LAST);--> statement-breakpoint
INSERT INTO "setup_state" ("id") VALUES (1) ON CONFLICT DO NOTHING;--> statement-breakpoint
-- settings_audit is append-only (D10): UPDATE and DELETE raise, except the FK's `on delete set null` of actor_person.
CREATE FUNCTION settings_audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.actor_person IS NULL AND OLD.actor_person IS NOT NULL
    AND (NEW.id, NEW.at, NEW.actor_label, NEW.source, NEW.action, NEW.key, NEW.old_value, NEW.new_value, NEW.old_fp,
      NEW.new_fp, NEW.result, NEW.ip, NEW.request_id)
    IS NOT DISTINCT FROM (OLD.id, OLD.at, OLD.actor_label, OLD.source, OLD.action, OLD.key, OLD.old_value,
      OLD.new_value, OLD.old_fp, OLD.new_fp, OLD.result, OLD.ip, OLD.request_id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'settings_audit is append-only';
END
$$;--> statement-breakpoint
CREATE TRIGGER settings_audit_append_only BEFORE UPDATE OR DELETE ON "settings_audit"
  FOR EACH ROW EXECUTE FUNCTION settings_audit_append_only();
