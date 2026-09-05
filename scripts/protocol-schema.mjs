#!/usr/bin/env node
// Writes the protocol's JSON Schema documents (PRD-02 T1, decision 2): one
// file per link under `packages/protocol/schema/`, produced from the Zod
// schemas the package built into `dist/index.mjs` a moment ago (`pnpm build` runs
// tsdown, then this, then `protocol-codegen.mjs`). The files are committed;
// `packages/protocol/src/schema.test.ts` fails when they are stale.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const protocol = join(repo, 'packages/protocol')
const outDir = join(protocol, 'schema')

const { PROTOCOL_SCHEMA_FILES, stringifySchemaDocument } = await import(
  pathToFileURL(join(protocol, 'dist/index.mjs')).href
)

mkdirSync(outDir, { recursive: true })
for (const [file, produce] of Object.entries(PROTOCOL_SCHEMA_FILES)) {
  const path = join(outDir, file)
  const text = stringifySchemaDocument(produce())
  let previous = ''
  try {
    previous = readFileSync(path, 'utf8')
  } catch {
    // first export
  }
  if (previous === text) {
    console.log(`protocol-schema: ${file} unchanged`)
    continue
  }
  writeFileSync(path, text)
  console.log(`protocol-schema: wrote ${file}`)
}
