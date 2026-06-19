CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"deal_id" uuid NOT NULL,
	"action" text NOT NULL,
	"approver" text NOT NULL,
	"reason" text,
	"decided_at" timestamp with time zone NOT NULL
);
