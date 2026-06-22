CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text,
	"deployment_id" text,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" text NOT NULL
);
