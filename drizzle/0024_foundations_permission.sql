-- Auth/IAM — add the panel-only `system:foundations` permission key + grant it to admin.
-- PANEL-ENFORCED ONLY: no pipeline /api route checks this key; it exists so the admin panel
-- can gate its read-only Foundations / style-guide screen and so the key is grantable in the
-- Roles editor. The 0022 admin cross-join ran ONCE and does NOT pick up keys added later, so
-- the admin grant must be inserted explicitly here. Idempotent (ON CONFLICT). The in-memory
-- adapter + test harness derive admin from ALL_PERMISSIONS and auto-get it; only Postgres —
-- the live path — needs this migration. No reviewer grant by design.
INSERT INTO "permissions" ("key", "label") VALUES
	('system:foundations', 'Access the panel Foundations / style-guide screen')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_key") VALUES
	('00000000-0000-4000-a000-0000000000a1', 'system:foundations')
ON CONFLICT DO NOTHING;
