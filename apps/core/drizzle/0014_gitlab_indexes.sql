ALTER TABLE "project_repos" ALTER COLUMN "default_branch" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX "merge_requests_work_item_idx" ON "merge_requests" USING btree ("work_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "work_item_repos_repo_issue_unique" ON "work_item_repos" USING btree ("repo_id","issue_iid") WHERE "work_item_repos"."issue_iid" is not null;