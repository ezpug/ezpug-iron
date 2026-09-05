import { fileURLToPath } from 'node:url'
import { defineConfig } from 'drizzle-kit'

// drizzle-kit runs from apps/orchestrator, but the one env file lives at the
// repo root (`.env.example` documents the layering). loadEnvFile never
// overwrites an already-set variable, so `EZPUG_IRON_DATABASE_URL=… pnpm
// db:generate` still wins.
try {
  process.loadEnvFile(fileURLToPath(new URL('../../.env', import.meta.url)))
} catch {
  // No .env — fine for `generate`, which never connects.
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  // Table and column names are snake_case even when a schema omits them, so
  // a forgotten explicit name can never produce a camelCase column.
  casing: 'snake_case',
  dbCredentials: { url: process.env.EZPUG_IRON_DATABASE_URL ?? '' },
  strict: true,
  verbose: true,
})
