-- Runs once, on an empty data volume (postgres entrypoint initdb hook).
-- The Vitest test database lives beside the dev one so the orchestrator's
-- tests never touch the dev world; the connection strategy is
-- apps/orchestrator/src/db/testing.ts. Re-created by `pnpm dev:reset`
-- (which drops the volume). The initdb user owns it, which is the
-- POSTGRES_USER the orchestrator connects as.
CREATE DATABASE ezpug_iron_test;
