CREATE TABLE "api_key_budget_notices" (
	"key_id" uuid NOT NULL,
	"limit" text NOT NULL,
	"fraction" text NOT NULL,
	"month_started_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	CONSTRAINT "api_key_budget_notices_key_id_limit_fraction_month_started_at_pk" PRIMARY KEY("key_id","limit","fraction","month_started_at")
);
--> statement-breakpoint
ALTER TABLE "api_key_budget_notices" ADD CONSTRAINT "api_key_budget_notices_key_id_api_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;