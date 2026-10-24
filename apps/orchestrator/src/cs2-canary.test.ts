import { fileURLToPath } from 'node:url'
import { matchRequestSchema } from '@ezpug/match-api'
import { describe, expect, it } from 'vitest'

/**
 * **The dev-node canary** (PRD-10 T4): `pnpm cs2:canary`, the verb that boots
 * the CS2 image N times on the dev node and plays lane rows inside one hold of
 * the lane. What can be held without the game is held here, on fakes: the
 * verdict's shape, the refusals by name (a running container, a lane held by
 * somebody else, an image older than the tree, a volume Steam will not
 * update), the inheritance of a hold, and what a red boot does to the rows.
 * The real run is the progress line's.
 */

const REPO = fileURLToPath(new URL('../../../', import.meta.url))

type Boot = { cssMs: number | null; readyMs: number | null; failure: string | null }
type Verdict = {
  build: string
  sourceRevision: string | null
  steamBuildId: string | null
  image: string
  imageRef: string
  pins: Record<string, string | null>
  boots: { cssMs: number | null; readyMs: number | null }[]
  rows: Record<string, 'green' | 'red' | 'skipped'>
  state: 'green' | 'red'
  reason: string | null
  at: string
}
type Lane = {
  read: () => { token: string; holder: string; pid: number; host: string; since: string } | null
  take: (options: { waitMs: number; what: string }) => Promise<{ entry: { token: string } }>
  refresh: (token: string) => boolean
  release: (token: string) => boolean
}
type Options = {
  boots: number
  rows: string[]
  lockToken: string | null
  lockWaitMs: number
  install: boolean
  baseUrl: string | null
  json: boolean
  help: boolean
}
type CanaryModule = {
  BOOT_HANG_MS: number
  LANE_REFRESH_MS: number
  DEFAULT_ROWS: string[]
  Refusal: new (code: string, message: string) => Error & { code: string }
  parseArgs: (argv: string[]) => Options
  readSteamInf: (text: string) => { patchVersion: string | null; sourceRevision: string | null }
  readAppManifestBuildId: (text: string) => string | null
  readUpToDateCheck: (json: unknown) => string | null
  classifyConsoleLine: (line: string) => { kind: string; name?: string; line?: string } | null
  installFailure: (output: string) => string
  verdictPath: (build: string, root?: string) => string
  verdictLine: (verdict: Verdict) => string
  laneRowIds: (root?: string) => string[]
  bootRequest: (n: number) => Record<string, unknown>
  runCanary: (options: Options, deps: Record<string, unknown>) => Promise<{ verdict: Verdict }>
}

// A variable path: an operator script outside this app's tsconfig (as cs2-lane-lock.test.ts).
const modulePath = `${REPO}scripts/cs2-canary.mjs`
const canary = (await import(modulePath)) as CanaryModule

const PINS = {
  metamod: '2.0.0-git1483',
  counterstrikesharp: '1.0.378',
  matchzy: '0.8.15-ezpug.3',
  multiaddonmanager: '1.7',
}

/** The box, faked: every hand the verb has, recording what it was asked. */
function box(overrides: Record<string, unknown> = {}) {
  let now = 1_764_000_000_000
  const calls: string[] = []
  const written: { path: string; verdict: Verdict }[] = []
  const lines: string[] = []
  let lock: { token: string; holder: string; pid: number; host: string; since: string } | null =
    null
  const lane: Lane = {
    read: () => lock,
    take: async ({ what }) => {
      calls.push(`take ${what}`)
      lock = { token: 'tok-mine', holder: 'ezpug-iron', pid: 1, host: 'box', since: 'then' }
      return { entry: { token: 'tok-mine' } }
    },
    refresh: token => {
      calls.push(`refresh ${token}`)
      return true
    },
    release: token => {
      calls.push(`release ${token}`)
      lock = null
      return true
    },
  }
  let volume: { patchVersion: string; sourceRevision: string; buildId: string } | null = {
    patchVersion: '1.41.9.2',
    sourceRevision: '11162119',
    buildId: '26144732',
  }
  const timers: { ms: number; fn: () => void; stopped: boolean }[] = []
  const deps = {
    every: (ms: number, fn: () => void) => {
      const timer = { ms, fn, stopped: false }
      timers.push(timer)
      return () => {
        timer.stopped = true
      }
    },
    clock: {
      now: () => now,
      sleep: async (ms: number) => {
        now += ms
      },
    },
    say: (line: string) => lines.push(line),
    lane,
    runningContainers: () => [] as string[],
    image: () => ({
      ref: 'ghcr.io/ezpug/ezpug-iron/cs2:dev',
      revision: 'a815c09',
      counterStrikeSharp: '1.0.378',
    }),
    treePins: () => PINS,
    steamBuild: async () => '1.41.9.2',
    volumeBuild: () => volume,
    install: async () => {
      calls.push('install')
      volume = { patchVersion: '1.41.9.2', sourceRevision: '11162119', buildId: '26144732' }
      return { ok: true, output: 'Success! App 730 fully installed.' }
    },
    prepare: async () => {
      calls.push('prepare')
    },
    boot: async (n: number): Promise<Boot> => {
      calls.push(`boot ${n}`)
      now += 20_000
      return { cssMs: 3_000 + n, readyMs: 6_000 + n, failure: null }
    },
    row: async (id: string, token: string) => {
      calls.push(`row ${id} ${token}`)
      now += 10 * 60_000
      return { ok: true, detail: null }
    },
    finish: async () => {
      calls.push('finish')
    },
    write: (path: string, verdict: Verdict) => written.push({ path, verdict }),
    ...overrides,
  }
  return {
    deps,
    timers,
    calls,
    written,
    lines,
    setLock: (entry: typeof lock) => {
      lock = entry
    },
    setVolume: (v: typeof volume) => {
      volume = v
    },
  }
}

const options = (over: Partial<Options> = {}): Options => ({
  ...canary.parseArgs([]),
  ...over,
})

async function refusal(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    return error as Error & { code: string }
  }
  throw new Error('the canary did not refuse')
}

describe('pnpm cs2:canary', () => {
  it('writes one verdict per build: the boots, the rows, the image and its pins', async () => {
    const fake = box()
    const { verdict } = await canary.runCanary(options({ boots: 3 }), fake.deps)

    expect(verdict).toEqual({
      build: '1.41.9.2',
      sourceRevision: '11162119',
      steamBuildId: '26144732',
      image: 'a815c09',
      imageRef: 'ghcr.io/ezpug/ezpug-iron/cs2:dev',
      pins: PINS,
      boots: [
        { cssMs: 3_001, readyMs: 6_001 },
        { cssMs: 3_002, readyMs: 6_002 },
        { cssMs: 3_003, readyMs: 6_003 },
      ],
      rows: { retakes: 'green', 'pug-2v1': 'green' },
      state: 'green',
      reason: null,
      at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
    })
    expect(fake.written).toHaveLength(1)
    expect(fake.written[0]?.path).toBe(canary.verdictPath('1.41.9.2'))
    expect(fake.written[0]?.path).toMatch(/\.verify\/cs2-canary-1\.41\.9\.2\.json$/)
    // The lane first, the rows inside the same hold, the lane last.
    expect(fake.calls[0]).toMatch(/^take /)
    expect(fake.calls).toContain('row retakes tok-mine')
    expect(fake.calls.at(-1)).toBe('release tok-mine')
    expect(fake.calls).not.toContain('install')
    expect(canary.verdictLine(verdict)).toBe(
      'cs2:canary green on CS2 1.41.9.2 with image a815c09: 3 boots (6.0s 6.0s 6.0s); rows: retakes green, pug-2v1 green',
    )
  })

  it('refuses while a CS2 container runs, judging nothing and giving the lane back', async () => {
    const fake = box({ runningContainers: () => ['ezpug-node-devbox'] })
    const error = await refusal(canary.runCanary(options(), fake.deps))

    expect(error).toBeInstanceOf(canary.Refusal)
    expect(error.code).toBe('container')
    expect(error.message).toContain('ezpug-node-devbox')
    expect(fake.calls.some(c => c.startsWith('boot'))).toBe(false)
    expect(fake.written).toEqual([])
    expect(fake.calls.slice(-2)).toEqual(['finish', 'release tok-mine'])
  })

  it('plays inside a hold it was handed, taking and releasing nothing', async () => {
    const fake = box()
    fake.setLock({ token: 'tok-hand', holder: 'ezpug-iron', pid: 7, host: 'box', since: 'then' })
    await canary.runCanary(options({ boots: 1, lockToken: 'tok-hand' }), fake.deps)

    expect(fake.calls.some(c => c.startsWith('take') || c.startsWith('release'))).toBe(false)
    expect(fake.calls).toContain('row retakes tok-hand')
    expect(fake.calls).toContain('row pug-2v1 tok-hand')
  })

  it('refuses a hold the lock on the box does not carry', async () => {
    const fake = box()
    fake.setLock({
      token: 'tok-platform',
      holder: 'ezpug-platform',
      pid: 9,
      host: 'box',
      since: '2026-10-24T10:00:00.000Z',
    })
    const error = await refusal(canary.runCanary(options({ lockToken: 'tok-hand' }), fake.deps))
    expect(error.code).toBe('lane')
    expect(error.message).toContain('ezpug-platform')
    expect(fake.calls).toEqual([])
  })

  it('names the holder when the wait for the lane runs out', async () => {
    const fake = box()
    fake.deps.lane.take = async () => {
      throw new Error('waited 45 minutes for the CS2 lane lock, held by ezpug-platform (pid 9)')
    }
    const error = await refusal(canary.runCanary(options(), fake.deps))
    expect(error.code).toBe('lane')
    expect(error.message).toContain('ezpug-platform')
  })

  it('refuses an image built against another CounterStrikeSharp than the tree pins', async () => {
    const fake = box({
      image: () => ({ ref: 'cs2:dev', revision: 'ded8c12', counterStrikeSharp: '1.0.376' }),
    })
    const error = await refusal(canary.runCanary(options(), fake.deps))
    expect(error.code).toBe('image')
    expect(error.message).toContain('pnpm cs2:build')
  })

  it("brings a trailing volume to Steam's public build before it boots", async () => {
    const fake = box()
    fake.setVolume({ patchVersion: '1.41.8.2', sourceRevision: '11026673', buildId: '1' })
    const { verdict } = await canary.runCanary(options({ boots: 1, rows: [] }), fake.deps)
    expect(fake.calls.indexOf('install')).toBeLessThan(fake.calls.indexOf('boot 1'))
    expect(verdict.build).toBe('1.41.9.2')

    const none = box()
    none.setVolume(null)
    await canary.runCanary(options({ boots: 1, rows: [] }), none.deps)
    expect(none.calls).toContain('install')
  })

  it('names "no delta" by its cause and does not retry it', async () => {
    let installs = 0
    const fake = box({
      install: async () => {
        installs++
        return {
          ok: false,
          output:
            "Failed to get manifest request code, 'Access Denied'\nError! App '730' state is 0x6 after update job.",
        }
      },
    })
    fake.setVolume({ patchVersion: '1.41.7.8', sourceRevision: '1', buildId: '1' })
    const error = await refusal(canary.runCanary(options(), fake.deps))
    expect(error.code).toBe('install')
    expect(error.message).toContain('Steam will not serve a delta')
    expect(error.message).toContain('not retried')
    expect(installs).toBe(1)
    expect(fake.calls.at(-1)).toBe('release tok-mine')
  })

  it('refuses instead of installing under --no-install, and when Steam cannot be read', async () => {
    const fake = box()
    fake.setVolume({ patchVersion: '1.41.8.2', sourceRevision: '1', buildId: '1' })
    const error = await refusal(canary.runCanary(options({ install: false }), fake.deps))
    expect(error.code).toBe('volume')
    expect(error.message).toContain('1.41.8.2')
    expect(error.message).toContain('1.41.9.2')

    const quiet = box({ steamBuild: async () => null })
    const { verdict } = await canary.runCanary(options({ boots: 1, rows: [] }), quiet.deps)
    expect(verdict.build, 'with Steam silent, the volume judges its own build').toBe('1.41.9.2')
  })

  it('stops at a red boot, skips the rows, and says which boot and why', async () => {
    const fake = box({
      boot: async (n: number): Promise<Boot> =>
        n < 3
          ? { cssMs: 3_000, readyMs: 6_000, failure: null }
          : {
              cssMs: null,
              readyMs: null,
              failure:
                'no server_ready 60 s after the request (a hang; CounterStrikeSharp never spoke)',
            },
    })
    const { verdict } = await canary.runCanary(options({ boots: 8 }), fake.deps)
    expect(verdict.state).toBe('red')
    expect(verdict.boots).toHaveLength(3)
    expect(verdict.reason).toBe(
      'boot 3: no server_ready 60 s after the request (a hang; CounterStrikeSharp never spoke)',
    )
    expect(verdict.rows).toEqual({ retakes: 'skipped', 'pug-2v1': 'skipped' })
    expect(fake.calls.some(c => c.startsWith('row'))).toBe(false)
    expect(fake.written).toHaveLength(1)
  })

  it('is red on a red row, and plays the rows after it', async () => {
    const fake = box({
      row: async (id: string) => ({
        ok: id !== 'retakes',
        detail: id === 'retakes' ? 'exit 1' : null,
      }),
    })
    const { verdict } = await canary.runCanary(options({ boots: 1 }), fake.deps)
    expect(verdict.state).toBe('red')
    expect(verdict.rows).toEqual({ retakes: 'red', 'pug-2v1': 'green' })
    expect(verdict.reason).toBe('row retakes red: exit 1')
  })

  it('refreshes a hold it owns on a timer, through the install too, and stops it', async () => {
    const fake = box({
      install: async () => {
        // A 67 GB install is one call: the timer, not the steps, keeps the hold alive.
        for (const timer of fake.timers) if (!timer.stopped) timer.fn()
        fake.setVolume({
          patchVersion: '1.41.9.2',
          sourceRevision: '11162119',
          buildId: '26144732',
        })
        return { ok: true, output: '' }
      },
    })
    fake.setVolume(null)
    await canary.runCanary(options({ boots: 1 }), fake.deps)
    expect(fake.timers.map(t => t.ms)).toEqual([canary.LANE_REFRESH_MS])
    expect(canary.LANE_REFRESH_MS).toBeLessThan(90 * 60_000)
    expect(fake.calls.indexOf('refresh tok-mine')).toBeLessThan(fake.calls.indexOf('boot 1'))
    expect(fake.timers[0]?.stopped, 'the refresh outlived the hold').toBe(true)

    const inherited = box()
    inherited.setLock({ token: 'tok-hand', holder: 'ezpug-iron', pid: 7, host: 'box', since: '' })
    await canary.runCanary(options({ boots: 1, lockToken: 'tok-hand' }), inherited.deps)
    expect(inherited.timers, 'refreshed somebody else’s hold').toEqual([])
  })
})

describe('what cs2:canary reads', () => {
  it('parses its flags, and refuses what it cannot use', () => {
    expect(canary.parseArgs([])).toMatchObject({ boots: 8, rows: canary.DEFAULT_ROWS })
    expect(canary.parseArgs(['--boots', '3', '--rows', 'retakes'])).toMatchObject({
      boots: 3,
      rows: ['retakes'],
    })
    expect(canary.parseArgs(['--rows', 'none']).rows).toEqual([])
    expect(canary.parseArgs(['--lock-token', 'abc', '--no-install'])).toMatchObject({
      lockToken: 'abc',
      install: false,
    })
    expect(() => canary.parseArgs(['--boots', '0'])).toThrow(/1 to 50/)
    expect(() => canary.parseArgs(['--frobnicate'])).toThrow(/unknown flag/)
  })

  it('knows the lane rows it defaults to', () => {
    const ids = canary.laneRowIds()
    for (const id of canary.DEFAULT_ROWS) expect(ids).toContain(id)
  })

  it("reads the build's three names off a volume and Valve", () => {
    expect(
      canary.readSteamInf(
        'ClientVersion=2000935\nServerVersion=2000935\nPatchVersion=1.41.9.2\nProductName=cs2\nSourceRevision=11162119\n',
      ),
    ).toEqual({ patchVersion: '1.41.9.2', sourceRevision: '11162119' })
    expect(
      canary.readAppManifestBuildId(
        '"AppState"\n{\n\t"appid"\t\t"730"\n\t"buildid"\t\t"26144732"\n}',
      ),
    ).toBe('26144732')
    expect(
      canary.readUpToDateCheck({
        response: {
          success: true,
          up_to_date: false,
          version_is_listable: false,
          required_version: 14192,
          message: 'Server version required: 1.41.9.2',
        },
      }),
    ).toBe('1.41.9.2')
    expect(canary.readUpToDateCheck({ response: { success: false } })).toBeNull()
  })

  it('reads a console: the first CounterStrikeSharp line, and the lines that make a boot red', () => {
    expect(
      canary.classifyConsoleLine(
        '[21:38:37.013] CSSharp: Initializing with command line: "/serverdata/…/cs2" -dedicated',
      ),
    ).toEqual({ kind: 'css' })
    expect(
      canary.classifyConsoleLine('\x1b[31mFailed to find signature CBaseEntity_Teleport\x1b[0m'),
    ).toEqual({
      kind: 'fatal',
      name: 'Failed to find signature',
      line: 'Failed to find signature CBaseEntity_Teleport',
    })
    expect(
      canary.classifyConsoleLine('Engine2PreBreakpadDumpFunction: version(1.41.9.2)')?.name,
    ).toBe('Engine2PreBreakpadDumpFunction')
    expect(canary.classifyConsoleLine('L 10/24 Host activate: Loading (de_dust2)')).toBeNull()
  })

  it('composes a boot as a pug nobody plays, pinned to the dev node, that the door accepts', () => {
    const request = canary.bootRequest(2)
    expect(matchRequestSchema.safeParse(request).error?.issues).toBeUndefined()
    expect(request).toMatchObject({
      gamemode: 'pug',
      maps: [{ map: 'de_dust2', sides: 'ct' }],
      requirements: { provider: 'nodes' },
      teams: { teamA: { players: [] }, teamB: { players: [] } },
    })
    expect(JSON.stringify(request)).not.toContain('simulation')
  })

  it('names an install that ran out of disk', () => {
    expect(canary.installFailure('steamcmd needs at least 250MB of free disk space')).toContain(
      'ran out of disk',
    )
    expect(canary.installFailure('something else\nbroke')).toContain('cs2:install failed')
  })
})
