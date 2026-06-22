CREATE TABLE "alert_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"dedupe_key" text NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"context" jsonb NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "alert_events_status_idx" ON "alert_events" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "alert_events_open_dedupe_unique" ON "alert_events" USING btree ("dedupe_key") WHERE "alert_events"."status" = 'open';