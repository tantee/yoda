ALTER TABLE "notifications" DROP CONSTRAINT "notifications_kind_check";--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_kind_check" CHECK ("notifications"."kind" in ('task_assigned', 'proposal_pending', 'request_update', 'work_item_stuck', 'secretary_message', 'budget_alert'));--> statement-breakpoint
UPDATE "notifications" SET "kind" = 'budget_alert' WHERE "kind" = 'secretary_message' AND "dedupe_key" LIKE 'dept-ai-budget:%';
