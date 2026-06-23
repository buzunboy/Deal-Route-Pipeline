-- Auth/IAM Phase 1 — consolidate `team_members` → `users` (the IdP identity store).
-- A RENAME (not drop+create) preserves ids + emails so reviews.approver (keyed on
-- email) is untouched and existing reviewer rows survive. The unique email index rides
-- the rename; we rename it to match the new table. New auth columns are ADDED nullable
-- / defaulted so the rename + existing automated paths round-trip. The legacy text
-- `role` column is KEPT here so migration 0020 can backfill `role_id` from it, then
-- drop it.
ALTER TABLE "team_members" RENAME TO "users";--> statement-breakpoint
ALTER INDEX "team_members_email_unique" RENAME TO "users_email_unique";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "role_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_hash" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "auth_provider" text DEFAULT 'password' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "google_sub" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "token_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_login_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "failed_login_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "locked_until" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "users_role_idx" ON "users" USING btree ("role_id");
