CREATE TABLE "game_builds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"deployment" text DEFAULT 'ezpug' NOT NULL,
	"build" text NOT NULL,
	"steam_build_id" text,
	"source_revision" text,
	"observed_at" timestamp with time zone NOT NULL,
	"issue_number" integer,
	"issue_url" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "game_facts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"deployment" text DEFAULT 'ezpug' NOT NULL,
	"type" text NOT NULL,
	"build" text,
	"at" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "game_provider_states" (
	"id" uuid PRIMARY KEY NOT NULL,
	"deployment" text DEFAULT 'ezpug' NOT NULL,
	"provider" text NOT NULL,
	"build" text,
	"build_since" timestamp with time zone,
	"stack" text,
	"canary" jsonb NOT NULL,
	"hud" jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "game_builds_deployment_build_key" ON "game_builds" USING btree ("deployment","build");--> statement-breakpoint
CREATE INDEX "game_facts_deployment_at_idx" ON "game_facts" USING btree ("deployment","at");--> statement-breakpoint
CREATE INDEX "game_facts_deployment_type_idx" ON "game_facts" USING btree ("deployment","type");--> statement-breakpoint
CREATE UNIQUE INDEX "game_provider_states_deployment_provider_key" ON "game_provider_states" USING btree ("deployment","provider");