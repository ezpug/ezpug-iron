/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { matchApiJsonSchemas, matchApiSchemas } from './schemas'

describe('the schema registry', () => {
  it('exports every registered shape as JSON Schema — the C# generator’s input', () => {
    const documents = matchApiJsonSchemas()
    for (const name of Object.keys(matchApiSchemas)) {
      const document = documents[name as keyof typeof documents]
      expect(document, name).toBeDefined()
      expect(document.$schema, name).toBe('https://json-schema.org/draft/2020-12/schema')
    }
  })

  it('keeps a default a client may omit optional in the generated shape', () => {
    const request = matchApiJsonSchemas().MatchRequest as {
      required?: string[]
      properties: Record<string, unknown>
    }
    expect(request.required).not.toContain('requirements')
    expect(request.required).toContain('callbacks')
    expect(request.properties).toHaveProperty('ttlMinutes')
  })
})

/**
 * PRD-01's working rule: nothing in this package knows a provider. The words
 * may appear in a doc comment (to say why a shape is what it is), never in
 * code — `provider` is a badge string and `sim.*` is the one command family.
 */
describe('nothing in the package knows a provider', () => {
  const root = new URL('.', import.meta.url).pathname

  function sourceFiles(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      // The platform's fixtures are copied data (a MatchZy backup filename
      // is in one); the rule is about code that knows a provider.
      if (path.endsWith('/fixtures')) continue
      if (statSync(path).isDirectory()) out.push(...sourceFiles(path))
      else if (path.endsWith('.ts') && !path.endsWith('.test.ts')) out.push(path)
    }
    return out
  }

  it('mentions dathost or matchzy in comments at most', () => {
    const pattern = /dathost|matchzy/i
    // The one word in code: decision 14 names the manifest's flow owner
    // (`matchzy | plugin | none`) — a vocabulary value, not a provider seam.
    const allowed = [/z\.enum\(\['matchzy', 'plugin', 'none'\]\)/]
    for (const file of sourceFiles(root)) {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, index) => {
        if (!pattern.test(line) || allowed.some(rule => rule.test(line))) return
        const trimmed = line.trim()
        const isComment =
          trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')
        expect(isComment, `${file}:${index + 1}: ${trimmed}`).toBe(true)
      })
    }
  })
})
