-- Auth/IAM Phase 1 — server-side refresh tokens (hash-at-rest + rotation lineage) and
-- the global auth-counter store. `refresh_tokens.user_id` FKs to users with ON DELETE
-- CASCADE (a deleted user's sessions go with them). `auth_meta` holds the single global
-- `perm_version` counter (a DEDICATED table, not `settings`, so it never surfaces in the
-- panel's settings view); seeded to 0.
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"family_id" uuid NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"replaced_by" uuid,
	"user_agent" text,
	"ip" text
);--> statement-breakpoint
CREATE TABLE "auth_meta" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL
);--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "refresh_tokens_user_idx" ON "refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "refresh_tokens_token_hash_unique" ON "refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "refresh_tokens_family_idx" ON "refresh_tokens" USING btree ("family_id");--> statement-breakpoint
INSERT INTO "auth_meta" ("key", "value") VALUES ('perm_version', '0') ON CONFLICT ("key") DO NOTHING;
