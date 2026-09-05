import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PROTOCOL_CONSTANTS } from './constants'
import { PROTOCOL_SCHEMA_FILES, serverLinkJsonSchema, stringifySchemaDocument } from './schema'
import { LINK_COMMAND_TYPES, ORCHESTRATOR_FRAME_TYPES, SERVER_FRAME_TYPES } from './server-link'

/**
 * The JSON Schema documents under `schema/` are what `pnpm build` writes
 * (`scripts/protocol-schema.mjs`) and what the C# generator reads. This
 * proves the committed files are the current schemas — a Zod change without
 * a rebuild goes red here, with the command to run.
 */

const SCHEMA_DIR = fileURLToPath(new URL('../schema/', import.meta.url))

type Def = Record<string, unknown>

describe('the JSON Schema export', () => {
  for (const [file, produce] of Object.entries(PROTOCOL_SCHEMA_FILES)) {
    it(`schema/${file} is current (else: pnpm build)`, () => {
      expect(stringifySchemaDocument(produce())).toBe(readFileSync(`${SCHEMA_DIR}${file}`, 'utf8'))
    })
  }

  const document = serverLinkJsonSchema()
  const defs = document.$defs as Record<string, Def>

  it('carries the constants', () => {
    expect(document['x-constants']).toEqual(PROTOCOL_CONSTANTS)
    expect(document['x-protocol-version']).toBe(1)
  })

  it('names every branch of every union after its discriminator', () => {
    const branches = (name: string) =>
      ((defs[name] as { oneOf: { properties: { type: { const: string } } }[] }).oneOf ?? []).map(
        option => option.properties.type.const,
      )
    expect(branches('ServerFrame')).toEqual([...SERVER_FRAME_TYPES])
    expect(branches('OrchestratorFrame')).toEqual([...ORCHESTRATOR_FRAME_TYPES])
    expect(branches('LinkCommand')).toEqual([...LINK_COMMAND_TYPES])
    for (const name of ['ServerFrame', 'OrchestratorFrame', 'LinkCommand', 'GameserverEvent']) {
      expect(defs[name]?.['x-branch'], `${name} names its branch suffix`).toBeTypeOf('string')
    }
  })

  it('never makes a property both optional and nullable — the C# could not tell the two apart', () => {
    const offenders: string[] = []
    const walk = (node: unknown, path: string): void => {
      if (node === null || typeof node !== 'object') return
      if (Array.isArray(node)) {
        for (const [index, entry] of node.entries()) walk(entry, `${path}[${index}]`)
        return
      }
      const object = node as Def
      const properties = object.properties as Record<string, Def> | undefined
      if (properties) {
        const required = new Set((object.required as string[] | undefined) ?? [])
        for (const [key, property] of Object.entries(properties)) {
          const nullable =
            (Array.isArray(property.type) && property.type.includes('null')) ||
            (Array.isArray(property.anyOf) &&
              property.anyOf.some((option: Def) => option.type === 'null'))
          if (nullable && !required.has(key)) offenders.push(`${path}.${key}`)
        }
      }
      for (const [key, value] of Object.entries(object)) walk(value, `${path}.${key}`)
    }
    walk(defs, '$defs')
    expect(offenders).toEqual([])
  })
})
