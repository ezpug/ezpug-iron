/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { matchApiRoutes } from './routes'
import { flattenRoutes, MATCH_API_PREFIX } from './rpc'
import { MATCH_API_SCOPES } from './scopes'

const routes = flattenRoutes(matchApiRoutes)

describe('the Match API route table', () => {
  it('has every route under /v1 with a scope from the closed set', () => {
    expect(routes.length).toBeGreaterThan(20)
    for (const { key, route } of routes) {
      expect(route.path.startsWith(MATCH_API_PREFIX), key).toBe(true)
      expect(MATCH_API_SCOPES, key).toContain(route.scope)
    }
  })

  it('never declares the same method and path twice', () => {
    const seen = new Set<string>()
    for (const { route } of routes) {
      const signature = `${route.method.toUpperCase()} ${route.path}`
      expect(seen.has(signature), signature).toBe(false)
      seen.add(signature)
    }
  })

  it('answers 201 exactly on the creates', () => {
    const created = routes.filter(({ route }) => route.status === 201).map(({ key }) => key)
    expect(created.sort()).toEqual(
      ['matches.create', 'matches.mintPlayerToken', 'fleet.nodes.enrol', 'keys.create'].sort(),
    )
  })

  it('sends a body only on writes and a query only on reads', () => {
    for (const { key, route } of routes) {
      if (route.body) expect(route.method, key).not.toBe('get')
      if (route.query) expect(route.method, key).toBe('get')
    }
  })

  it('puts the money and the keys behind the narrow scopes', () => {
    for (const { key, route } of routes) {
      if (key.startsWith('keys.')) expect(route.scope, key).toBe('admin')
      else if (key.startsWith('fleet.')) expect(route.scope, key).toBe('fleet')
      else expect(route.scope, key).toBe('matches')
    }
  })

  it('declares two upgrades, the stream and the widget socket, and keeps them off the typed client', () => {
    const upgrades = routes.filter(({ route }) => route.upgrade).map(({ key }) => key)
    expect(upgrades).toEqual(['matches.stream', 'widget'])
    expect(matchApiRoutes.widget.path).toBe('/v1/widget')
    expect(matchApiRoutes.matches.stream.path).toBe('/v1/matches/:matchId/stream')
    expect(matchApiRoutes.matches.events.path).toBe('/v1/matches/:matchId/events')
  })

  it('has a section in docs/match-api.md for every route', () => {
    // The reference the platform loop reads instead of this code (PRD-01 T3,
    // T10): a route without a section is a route nobody was told about.
    const docs = readFileSync(new URL('../../../docs/match-api.md', import.meta.url), 'utf8')
    for (const { route } of routes) {
      const heading = `### \`${route.method.toUpperCase()} ${route.path}\``
      expect(docs.includes(heading), heading).toBe(true)
    }
  })

  it('documents no route that does not exist', () => {
    // The other direction: a section left behind by a rename is a lie the
    // platform loop would build against.
    const docs = readFileSync(new URL('../../../docs/match-api.md', import.meta.url), 'utf8')
    const documented = [...docs.matchAll(/^### `([A-Z]+) (\/v1\/\S*)`$/gm)].map(
      match => `${match[1]} ${match[2]}`,
    )
    const declared = new Set(
      routes.map(({ route }) => `${route.method.toUpperCase()} ${route.path}`),
    )
    expect(documented.length).toBe(routes.length)
    for (const signature of documented) expect(declared.has(signature), signature).toBe(true)
  })
})
