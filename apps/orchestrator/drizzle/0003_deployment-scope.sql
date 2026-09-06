ALTER TABLE "matches" ADD COLUMN "deployment" text DEFAULT 'ezpug' NOT NULL;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "deployment" text DEFAULT 'ezpug' NOT NULL;--> statement-breakpoint
CREATE INDEX "matches_deployment_state_idx" ON "matches" USING btree ("deployment","state");--> statement-breakpoint
CREATE INDEX "servers_deployment_open_idx" ON "servers" USING btree ("deployment","released_at");