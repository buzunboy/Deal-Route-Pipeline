CREATE TABLE "source_reviews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source_id" uuid NOT NULL,
	"action" text NOT NULL,
	"approver" text NOT NULL,
	"reason" text,
	"decided_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "source_reviews_source_idx" ON "source_reviews" USING btree ("source_id","decided_at");