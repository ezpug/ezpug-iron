CREATE TABLE "api_key_webhook_secrets" (
	"key_id" uuid NOT NULL,
	"id" text NOT NULL,
	"secret" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "api_key_webhook_secrets_key_id_id_pk" PRIMARY KEY("key_id","id")
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"secret_hash" text NOT NULL,
	"scopes" text[] NOT NULL,
	"budget_max_concurrent_servers" integer NOT NULL,
	"budget_max_server_lifetime_minutes" integer NOT NULL,
	"budget_monthly_cents" integer NOT NULL,
	"fleet_webhook_url" text,
	"fleet_webhook_secret_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "backups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"match_id" uuid NOT NULL,
	"fleet_server_id" uuid,
	"map_number" integer NOT NULL,
	"round_number" integer NOT NULL,
	"filename" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "match_commands" (
	"match_id" uuid NOT NULL,
	"correlation_id" text NOT NULL,
	"command_json" jsonb NOT NULL,
	"result_json" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "match_commands_match_id_correlation_id_pk" PRIMARY KEY("match_id","correlation_id")
);
--> statement-breakpoint
CREATE TABLE "match_events" (
	"match_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"delivery_id" uuid NOT NULL,
	"type" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "match_events_match_id_seq_pk" PRIMARY KEY("match_id","seq"),
	CONSTRAINT "match_events_delivery_id_key" UNIQUE("delivery_id")
);
--> statement-breakpoint
CREATE TABLE "matches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key_id" uuid NOT NULL,
	"client_match_id" text NOT NULL,
	"state" text NOT NULL,
	"state_changed_at" timestamp with time zone NOT NULL,
	"game" text NOT NULL,
	"gamemode" text NOT NULL,
	"provider" text,
	"server_id" text,
	"fleet_server_id" uuid,
	"connect" jsonb,
	"tv" jsonb,
	"seq" integer DEFAULT 0 NOT NULL,
	"request_json" jsonb NOT NULL,
	"request_hash" text NOT NULL,
	"ended_reason" jsonb,
	"sim" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"ready_at" timestamp with time zone,
	"live_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"webhooks_stopped_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"match_id" uuid NOT NULL,
	"key_id" uuid NOT NULL,
	"steam_id64" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"delivery_id" uuid PRIMARY KEY NOT NULL,
	"match_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"url" text NOT NULL,
	"secret_id" text NOT NULL,
	"status" text NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_status" integer,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gslt_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"steam_id" text NOT NULL,
	"app_id" integer DEFAULT 730 NOT NULL,
	"login_token" text NOT NULL,
	"memo" text NOT NULL,
	"leased_by_server_id" uuid,
	"leased_at" timestamp with time zone,
	"last_reset_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "node_enrolments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"node_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"region" text NOT NULL,
	"labels" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" text,
	"image_digest" text,
	"connected" boolean DEFAULT false NOT NULL,
	"drained" boolean DEFAULT false NOT NULL,
	"capacity_total" integer DEFAULT 0 NOT NULL,
	"capacity_in_use" integer DEFAULT 0 NOT NULL,
	"capacity_warm" integer DEFAULT 0 NOT NULL,
	"token_hash" text,
	"last_seen_at" timestamp with time zone,
	"enrolled_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "server_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"fleet_server_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "servers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"server_id" text,
	"node_id" text,
	"match_id" uuid,
	"key_id" uuid NOT NULL,
	"state" text NOT NULL,
	"game" text NOT NULL,
	"region" text,
	"lan" boolean DEFAULT false NOT NULL,
	"address" jsonb,
	"tv" jsonb,
	"cost_hourly_cents" integer NOT NULL,
	"gslt_token_id" uuid,
	"provider_meta" jsonb,
	"versions" jsonb,
	"hostname" text,
	"current_map" text,
	"link_state" text,
	"link_acked_seq" integer DEFAULT 0 NOT NULL,
	"last_seen_at" timestamp with time zone,
	"rcon_audit" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_error" text,
	"released_reason" text,
	"allocated_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_key_webhook_secrets" ADD CONSTRAINT "api_key_webhook_secrets_key_id_api_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_commands" ADD CONSTRAINT "match_commands_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_events" ADD CONSTRAINT "match_events_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_key_id_api_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_tokens" ADD CONSTRAINT "player_tokens_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_tokens" ADD CONSTRAINT "player_tokens_key_id_api_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_delivery_id_match_events_delivery_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."match_events"("delivery_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_enrolments" ADD CONSTRAINT "node_enrolments_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_tokens" ADD CONSTRAINT "server_tokens_fleet_server_id_servers_id_fk" FOREIGN KEY ("fleet_server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "servers" ADD CONSTRAINT "servers_key_id_api_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_secret_hash_key" ON "api_keys" USING btree ("secret_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_name_live_key" ON "api_keys" USING btree ("name") WHERE revoked_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "backups_match_round_key" ON "backups" USING btree ("match_id","map_number","round_number");--> statement-breakpoint
CREATE UNIQUE INDEX "matches_key_client_match_key" ON "matches" USING btree ("key_id","client_match_id");--> statement-breakpoint
CREATE INDEX "matches_key_created_idx" ON "matches" USING btree ("key_id","created_at");--> statement-breakpoint
CREATE INDEX "matches_state_idx" ON "matches" USING btree ("state");--> statement-breakpoint
CREATE UNIQUE INDEX "player_tokens_hash_key" ON "player_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "player_tokens_match_idx" ON "player_tokens" USING btree ("match_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_due_idx" ON "webhook_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_match_idx" ON "webhook_deliveries" USING btree ("match_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gslt_tokens_steam_id_key" ON "gslt_tokens" USING btree ("steam_id");--> statement-breakpoint
CREATE UNIQUE INDEX "node_enrolments_hash_key" ON "node_enrolments" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "server_tokens_hash_key" ON "server_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "server_tokens_server_idx" ON "server_tokens" USING btree ("fleet_server_id");--> statement-breakpoint
CREATE INDEX "servers_open_idx" ON "servers" USING btree ("provider","released_at");--> statement-breakpoint
CREATE INDEX "servers_match_idx" ON "servers" USING btree ("match_id");--> statement-breakpoint
CREATE INDEX "servers_key_allocated_idx" ON "servers" USING btree ("key_id","allocated_at");