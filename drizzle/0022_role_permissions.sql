-- Auth/IAM Phase 1 — the `role_permissions` grants (composite PK + FKs) and the seed:
-- admin → ALL permission keys; reviewer → read keys + approve/reject/edit +
-- manual-capture + evidence:read (the plan's least-privilege reviewer bundle). admin's
-- grants are derived by cross-joining every catalogued permission, so adding a new
-- permission key (migration) auto-extends admin without touching this seed list.
CREATE TABLE "role_permissions" (
	"role_id" uuid NOT NULL,
	"permission_key" text NOT NULL,
	CONSTRAINT "role_permissions_role_id_permission_key_pk" PRIMARY KEY("role_id","permission_key")
);--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_key_permissions_key_fk" FOREIGN KEY ("permission_key") REFERENCES "permissions"("key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- admin → every catalogued permission (auto-extends as new keys are added).
INSERT INTO "role_permissions" ("role_id", "permission_key")
SELECT '00000000-0000-4000-a000-0000000000a1'::uuid, "key" FROM "permissions"
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- reviewer → the least-privilege review bundle.
INSERT INTO "role_permissions" ("role_id", "permission_key") VALUES
	('00000000-0000-4000-a000-0000000000a2', 'candidate:read'),
	('00000000-0000-4000-a000-0000000000a2', 'candidate:approve'),
	('00000000-0000-4000-a000-0000000000a2', 'candidate:reject'),
	('00000000-0000-4000-a000-0000000000a2', 'candidate:edit'),
	('00000000-0000-4000-a000-0000000000a2', 'sources:read'),
	('00000000-0000-4000-a000-0000000000a2', 'settings:read'),
	('00000000-0000-4000-a000-0000000000a2', 'team:read'),
	('00000000-0000-4000-a000-0000000000a2', 'manual-capture:write'),
	('00000000-0000-4000-a000-0000000000a2', 'evidence:read')
ON CONFLICT DO NOTHING;
