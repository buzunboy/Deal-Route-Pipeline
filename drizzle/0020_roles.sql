-- Auth/IAM Phase 1 — the `roles` table + the two built-in system roles, then backfill
-- `users.role_id` from the legacy text `role` column and drop that column. The system
-- role ids are FIXED constants so the seed is idempotent and migration 0022 can grant
-- permissions against them by id without a lookup. Backfill: an existing 'admin' member
-- → admin role, everyone else → reviewer (the safe least-privilege default).
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "roles_name_unique" ON "roles" USING btree ("name");--> statement-breakpoint
INSERT INTO "roles" ("id", "name", "description", "is_system") VALUES
	('00000000-0000-4000-a000-0000000000a1', 'admin', 'Full administrative access — all permissions.', true),
	('00000000-0000-4000-a000-0000000000a2', 'reviewer', 'Reviews candidates: read, approve, reject, edit, manual capture.', true)
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
-- Backfill role_id from the legacy text role, defaulting unknown/empty to reviewer.
UPDATE "users" SET "role_id" = CASE
	WHEN "role" = 'admin' THEN '00000000-0000-4000-a000-0000000000a1'::uuid
	ELSE '00000000-0000-4000-a000-0000000000a2'::uuid
END;--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "role";--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE no action ON UPDATE no action;
