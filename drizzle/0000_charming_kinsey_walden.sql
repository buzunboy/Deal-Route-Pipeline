CREATE TABLE "changes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"deal_id" uuid,
	"source_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"previous_hash" text,
	"current_hash" text,
	"detected_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "condition_vocabulary" (
	"key" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"aliases" jsonb NOT NULL,
	"version" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crawl_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source_id" uuid NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"candidates_produced" integer NOT NULL,
	"cost_eur" double precision NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "deals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"schema_version" integer NOT NULL,
	"service" text NOT NULL,
	"route_type" text NOT NULL,
	"provider" text NOT NULL,
	"headline" text NOT NULL,
	"price_amount" double precision NOT NULL,
	"price_currency" text NOT NULL,
	"price_billing" text NOT NULL,
	"true_cost_monthly" double precision NOT NULL,
	"country" text NOT NULL,
	"new_customer_only" boolean,
	"residency_kyc" boolean,
	"plan_tier_required" text,
	"min_spend" double precision,
	"stackable" boolean,
	"validity_start" text,
	"validity_end" text,
	"recheck_days" integer NOT NULL,
	"eligibility_conditions" jsonb NOT NULL,
	"validity_conditions" jsonb NOT NULL,
	"included_items" jsonb NOT NULL,
	"attributes" jsonb NOT NULL,
	"raw_conditions_text" text NOT NULL,
	"grounding" jsonb NOT NULL,
	"field_proposals" jsonb NOT NULL,
	"unmapped_conditions" boolean NOT NULL,
	"source_url" text NOT NULL,
	"evidence_id" uuid NOT NULL,
	"confidence" double precision NOT NULL,
	"dedupe_key" text NOT NULL,
	"status" text NOT NULL,
	"verified_by" text,
	"verified_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source_url" text NOT NULL,
	"screenshot_ref" text NOT NULL,
	"html_ref" text NOT NULL,
	"terms_ref" text NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"content_hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "field_proposals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"suggested_key" text NOT NULL,
	"label" text NOT NULL,
	"rationale" text NOT NULL,
	"example_quote" text NOT NULL,
	"count" integer NOT NULL,
	"status" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "field_proposals_suggested_key_unique" UNIQUE("suggested_key")
);
--> statement-breakpoint
CREATE TABLE "manual_capture_tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source_id" uuid NOT NULL,
	"source_url" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"type" text NOT NULL,
	"tier" integer NOT NULL,
	"country" text NOT NULL,
	"subscription_service" text,
	"cadence_days" integer NOT NULL,
	"reliability_score" double precision NOT NULL,
	"status" text NOT NULL,
	"last_seen" timestamp with time zone,
	"next_due" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "subscription_catalog" (
	"service" text PRIMARY KEY NOT NULL,
	"category" text NOT NULL,
	"provider_url" text NOT NULL,
	"country" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "deals_status_idx" ON "deals" USING btree ("status");--> statement-breakpoint
CREATE INDEX "deals_dedupe_idx" ON "deals" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "sources_due_idx" ON "sources" USING btree ("status","next_due");