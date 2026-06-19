ALTER TABLE "crawl_runs" ALTER COLUMN "source_id" DROP NOT NULL;--> statement-breakpoint
--> Add run_kind with a temporary default so the NOT NULL ADD COLUMN succeeds on a
--> non-empty table: every pre-existing run is a Lane-A crawl. Drop the default
--> afterwards so new inserts must set run_kind explicitly (mirrors the schema, which
--> carries no column default — the app always supplies the kind).
ALTER TABLE "crawl_runs" ADD COLUMN "run_kind" text DEFAULT 'crawl' NOT NULL;--> statement-breakpoint
ALTER TABLE "crawl_runs" ALTER COLUMN "run_kind" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "crawl_runs" ADD COLUMN "proposals_produced" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "crawl_runs" ADD COLUMN "stopped_reason" text;
