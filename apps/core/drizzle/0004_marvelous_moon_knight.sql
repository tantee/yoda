DROP INDEX "events_work_item_created_idx";--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "created_at" SET DEFAULT clock_timestamp();--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "seq" bigserial NOT NULL;--> statement-breakpoint
CREATE INDEX "events_work_item_seq_idx" ON "events" USING btree ("work_item_id","seq");