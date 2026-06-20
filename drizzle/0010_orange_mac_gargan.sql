ALTER TABLE "deals" ADD COLUMN "affiliate_disclosure" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "published_at" timestamp with time zone;