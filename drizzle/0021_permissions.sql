-- Auth/IAM Phase 1 — the closed `permissions` catalog, seeded one row per
-- Permission.options key (with a human label for the panel role editor) so the UI can
-- enumerate keys without the enum shipping to the client. A unit test asserts this seed
-- and the `Permission` enum stay in sync (drift guard). `key` = Permission.options value.
CREATE TABLE "permissions" (
	"key" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL
);--> statement-breakpoint
INSERT INTO "permissions" ("key", "label") VALUES
	('candidate:read', 'View the review queue'),
	('candidate:approve', 'Approve candidates'),
	('candidate:reject', 'Reject candidates'),
	('candidate:edit', 'Edit candidate fields'),
	('sources:read', 'View sources'),
	('sources:write', 'Add sources'),
	('sources:review', 'Approve / reject proposed sources'),
	('settings:read', 'View settings'),
	('settings:write', 'Change settings'),
	('team:read', 'View users / team'),
	('team:manage', 'Manage users (create / edit / disable)'),
	('roles:manage', 'Manage roles & permissions'),
	('alerts:manage', 'Acknowledge / resolve alerts'),
	('field-proposals:promote', 'Promote field proposals into the vocabulary'),
	('manual-capture:write', 'Complete / create manual-capture tasks'),
	('evidence:read', 'Fetch evidence artifacts')
ON CONFLICT ("key") DO NOTHING;
