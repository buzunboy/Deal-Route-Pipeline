ALTER TABLE "deals" ADD COLUMN "source_registrable_domain" text;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "registrable_domain" text;