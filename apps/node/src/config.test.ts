import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_GAME_VOLUME, DEFAULT_IMAGE, linkUrlFor, readNodeConfig } from './config'

const BASE = { EZPUG_NODE_ORCHESTRATOR_URL: 'http://127.0.0.1:3430' }

describe('readNodeConfig', () => {
  it('reads the defaults a dev box needs and derives the link URL', () => {
    const config = readNodeConfig(BASE)
    expect(config.orchestratorUrl).toBe('http://127.0.0.1:3430')
    expect(config.linkUrl).toBe('ws://127.0.0.1:3430/node')
    expect(config.stateDir).toBe(join(homedir(), '.ezpug-node'))
    expect(config.region).toBe('eu-central')
    expect(config.lan).toBe(true)
    expect(config.labels).toEqual({})
    expect(config.maxInstances).toBe(2)
    expect(config.warm).toBe(1)
    expect(config.image).toBe(DEFAULT_IMAGE)
    expect(config.gameVolume).toBe(DEFAULT_GAME_VOLUME)
    expect(config.gamemodesDir).toBeNull()
    expect(config.dockerSocket).toBe('/var/run/docker.sock')
    expect(config.pollIntervalMs).toBe(2_000)
    expect(config.stopTimeoutSeconds).toBe(20)
    expect(config.production).toBe(false)
  })

  it('takes every variable from the environment', () => {
    const config = readNodeConfig({
      EZPUG_NODE_ORCHESTRATOR_URL: 'https://gs.ezpug.com/',
      EZPUG_NODE_STATE_DIR: '/var/lib/ezpug-node',
      EZPUG_NODE_REGION: 'eu-west',
      EZPUG_NODE_LAN: 'false',
      EZPUG_NODE_LABELS: 'venue=saarlan, tickrate=128,cores=16',
      EZPUG_NODE_MAX_INSTANCES: '4',
      EZPUG_NODE_WARM: '2',
      EZPUG_NODE_IMAGE: 'ghcr.io/ezpug/ezpug-iron/cs2:0.1.0',
      EZPUG_NODE_GAME_VOLUME: 'cs2',
      EZPUG_NODE_GAMEMODES_DIR: '/srv/ezpug-iron/gamemodes',
      EZPUG_NODE_DOCKER_SOCKET: '/run/docker.sock',
      EZPUG_NODE_POLL_INTERVAL_MS: '500',
      EZPUG_NODE_STOP_TIMEOUT: '5',
      NODE_ENV: 'production',
    })
    expect(config.orchestratorUrl).toBe('https://gs.ezpug.com')
    expect(config.linkUrl).toBe('wss://gs.ezpug.com/node')
    expect(config.stateDir).toBe('/var/lib/ezpug-node')
    expect(config.region).toBe('eu-west')
    expect(config.lan).toBe(false)
    expect(config.labels).toEqual({ venue: 'saarlan', tickrate: '128', cores: '16' })
    expect(config.maxInstances).toBe(4)
    expect(config.warm).toBe(2)
    expect(config.image).toBe('ghcr.io/ezpug/ezpug-iron/cs2:0.1.0')
    expect(config.gameVolume).toBe('cs2')
    expect(config.gamemodesDir).toBe('/srv/ezpug-iron/gamemodes')
    expect(config.dockerSocket).toBe('/run/docker.sock')
    expect(config.pollIntervalMs).toBe(500)
    expect(config.stopTimeoutSeconds).toBe(5)
    expect(config.production).toBe(true)
  })

  it('names the variable when the orchestrator URL is missing or not http(s)', () => {
    expect(() => readNodeConfig({})).toThrow(/EZPUG_NODE_ORCHESTRATOR_URL/)
    expect(() => readNodeConfig({ EZPUG_NODE_ORCHESTRATOR_URL: 'ws://x/node' })).toThrow(
      /EZPUG_NODE_ORCHESTRATOR_URL: must be the orchestrator’s http\(s\):\/\/ origin/,
    )
  })

  it('refuses a warm pool larger than the host runs', () => {
    expect(() =>
      readNodeConfig({ ...BASE, EZPUG_NODE_MAX_INSTANCES: '1', EZPUG_NODE_WARM: '2' }),
    ).toThrow(/EZPUG_NODE_WARM: 2 exceeds EZPUG_NODE_MAX_INSTANCES 1/)
  })

  it('refuses a label without a value and a region that is not kebab-case', () => {
    expect(() => readNodeConfig({ ...BASE, EZPUG_NODE_LABELS: 'venue' })).toThrow(
      /EZPUG_NODE_LABELS/,
    )
    expect(() => readNodeConfig({ ...BASE, EZPUG_NODE_REGION: 'EU Central' })).toThrow(
      /EZPUG_NODE_REGION/,
    )
  })

  it('derives the link URL under a path prefix too', () => {
    expect(linkUrlFor('https://example.org/iron/')).toBe('wss://example.org/iron/node')
    expect(linkUrlFor('http://localhost:3430?x=1#y')).toBe('ws://localhost:3430/node')
  })
})
