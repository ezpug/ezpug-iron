import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * **`pnpm game:follow`** (PRD-10 T5, decision 39): the pin bump as one verb,
 * and the policy of a patch. Held here without the box: the parser of
 * versions and notes against the real release JSON of 1.0.375, 1.0.376,
 * 1.0.378, MultiAddonManager 1.6.1 / 1.6.2 / 1.7 / 1.7.1 and the MatchZy
 * fork's tag (`scripts/__fixtures__/game-follow/`), the Metamod pair, the
 * homes rewritten on this very tree, the refusals by name with the tree left
 * at the last commit, a dry run that is byte-stable and touches nothing, and
 * `--auto` under `off` and `patch`. The real run is the progress line's.
 */

const REPO = fileURLToPath(new URL('../../../', import.meta.url))

type Release = {
  tag_name: string
  name: string
  published_at: string
  html_url: string
  body: string
  assets: { name: string; digest: string | null; size: number }[]
}
type Policy = { allowed: boolean; kind: string; why: string }
type Bump = {
  spec: string
  from: string
  to: string
  sha256?: string | null
  release: Release | null
  submoduleSha?: string | null
  policy?: Policy | null
}
type Home = { path: string; before: string; after: string }
type Tree = { dockerfile: string; props: string; pinsTs: string; pinsMd: string }
type Options = {
  specs: Record<string, string>
  auto: boolean
  dryRun: boolean
  target: string
  rows: string[]
  boots: number | null
  hud: boolean
  lockToken: string | null
  lockWaitMs: number
  orchestrator: string | null
  envFile: string
  trailers: string[]
  json: boolean
  help: boolean
}
type Report = {
  action: string
  target: string
  phases: string[]
  plan: string | null
  bumps: { spec: string; from: string; to: string }[]
  proof: string[]
  template: string
  image: string
  commit: string | null
  issue: { commented: boolean; number?: number } | null
  notes: string[]
}
type AutoReport = {
  action: string
  specs: Record<string, string>
  waiting: { repo: string; version: string; why: string }[]
  why: string
  follow: Report | null
}
type FollowModule = {
  HOMES: string[]
  PHASES: string[]
  DEFAULT_ROWS: string[]
  WAITING_MARKER: string
  Stop: new (phase: string, message: string) => Error & { phase: string }
  parseSpec: (text: string) => { spec: string; version: string }
  parseArgs: (argv: string[]) => Options
  versionTriple: (version: string) => number[] | null
  metamodVersion: (spec: string) => string | null
  bumpKind: (from: string, to: string) => string
  notesAllowPatch: (release: Release | null) => { ok: boolean; why: string }
  patchPolicy: (spec: string, pinned: string, candidate: string, release?: Release | null) => Policy
  releaseHeadline: (release: Release | null) => string | null
  metamodBinaryFacts: (buffer: Buffer) => { build: number | null; commits: string[] }
  metamodPairProblem: (input: {
    cssVersion: string
    submoduleSha: string | null
    metamodVersion: string
    binary: { build: number | null; commits: string[] }
  }) => string | null
  rewritePinsRow: (
    markdown: string,
    what: string,
    change: { from: string; to: string; sentence?: string | null },
  ) => string
  planHomes: (tree: Tree, bumps: Bump[], options: { day: string; proof?: string | null }) => Home[]
  readFollowEnv: (text: string) => Record<string, string | null>
  autoDecision: (input: {
    policy: string
    game: unknown
    releaseOf: (spec: string, version: string) => Promise<Release | null>
  }) => Promise<AutoReport>
  runFollow: (options: Options, deps: Record<string, unknown>) => Promise<Report>
  runAuto: (options: Options, deps: Record<string, unknown>) => Promise<AutoReport>
  commitMessage: (input: Record<string, unknown>) => string
}

// A variable path: an operator script outside this app's tsconfig (as cs2-canary.test.ts).
const modulePath = `${REPO}scripts/game-follow.mjs`
const follow = (await import(modulePath)) as FollowModule

const fixture = (name: string): Release =>
  JSON.parse(readFileSync(`${REPO}scripts/__fixtures__/game-follow/${name}.json`, 'utf8'))
const RELEASES: Record<string, Release> = {
  'roflmuffin/CounterStrikeSharp#v1.0.375': fixture('css-1.0.375'),
  'roflmuffin/CounterStrikeSharp#v1.0.376': fixture('css-1.0.376'),
  'roflmuffin/CounterStrikeSharp#v1.0.378': fixture('css-1.0.378'),
  'Source2ZE/MultiAddonManager#v1.6.1': fixture('mam-1.6.1'),
  'Source2ZE/MultiAddonManager#v1.6.2': fixture('mam-1.6.2'),
  'Source2ZE/MultiAddonManager#v1.7': fixture('mam-1.7'),
  'Source2ZE/MultiAddonManager#v1.7.1': fixture('mam-1.7.1'),
  'ezpug/MatchZy-Enhanced#v1.4.32-ezpug.1': fixture('matchzy-1.4.32-ezpug.1'),
}
const rel = (key: string): Release => RELEASES[key] as Release
/** A fictional CounterStrikeSharp release, as a feed would offer it. */
const fictional = (tag: string, body: string, name = tag): Release => ({
  tag_name: tag,
  name,
  published_at: '2026-11-01T10:00:00Z',
  html_url: `https://github.com/roflmuffin/CounterStrikeSharp/releases/tag/${tag}`,
  body,
  assets: [],
})

const home = (homes: Home[], path: string): Home => homes.find(h => h.path === path) as Home
const arg = (dockerfile: string, name: string): string | undefined =>
  dockerfile.match(new RegExp(`^ARG ${name}=(\\S+)$`, 'm'))?.[1]
/** The sha of MultiAddonManager 1.7's steamrt3 artifact, as the Dockerfile carried it. */
const MAM_17_SHA = 'eade247041c48c502a1c2c12db817ceb2a2310f88c2164ff82d90dfe7714a461'

/**
 * The tree as it is, read once, with MultiAddonManager held at 1.7 whatever
 * the tree pins today: the homes a bump writes, in the shape they had before
 * the verb's first real run moved them (2026-10-24). So these tests mean the
 * same thing before and after any later bump of that row.
 */
const TREE: Tree = (() => {
  const dockerfile = readFileSync(`${REPO}docker/cs2/Dockerfile`, 'utf8')
  const mam = arg(dockerfile, 'MULTIADDONMANAGER_VERSION') as string
  return {
    dockerfile: dockerfile
      .replace(/^ARG MULTIADDONMANAGER_VERSION=\S+$/m, 'ARG MULTIADDONMANAGER_VERSION=1.7')
      .replace(/^ARG MULTIADDONMANAGER_SHA256=\S+$/m, `ARG MULTIADDONMANAGER_SHA256=${MAM_17_SHA}`),
    props: readFileSync(`${REPO}plugins/Directory.Build.props`, 'utf8'),
    pinsTs: readFileSync(`${REPO}apps/orchestrator/src/game/pins.ts`, 'utf8').replace(
      /^(\s+multiAddonManager: )'[^']+',$/m,
      "$1'1.7',",
    ),
    pinsMd: readFileSync(`${REPO}docs/pins.md`, 'utf8').replace(
      `| MultiAddonManager | \`${mam}\`, \`steamrt3\` |`,
      '| MultiAddonManager | `1.7`, `steamrt3` |',
    ),
  }
})()
const PINNED = {
  css: arg(TREE.dockerfile, 'COUNTER_STRIKE_SHARP_VERSION') as string,
  metamod: arg(TREE.dockerfile, 'METAMOD_VERSION') as string,
  mam: arg(TREE.dockerfile, 'MULTIADDONMANAGER_VERSION') as string,
}
const SHA = {
  mam171: 'd40dc64a78c8278a5b00ee44ab2bcbc078ffa52f61661a009d12e0d44fe182d4',
  css: 'b7fcbd99619ab17e32b07a6af2bd5179d83e2c7a4c045e33cbd11e5492c87b7d',
  metamod: '0fdcccaa369937ed7f521c78462314b5266f39c1d65a84e4c2d3847324cd7776',
}
const SUBMODULE_1_0_378 = '170058a2f0dbd58106b7c76bfe88a94672295356'

const options = (over: Partial<Options> = {}): Options => ({
  specs: {},
  auto: false,
  dryRun: false,
  target: 'both',
  rows: follow.DEFAULT_ROWS,
  boots: null,
  hud: false,
  lockToken: null,
  lockWaitMs: 45 * 60_000,
  orchestrator: null,
  envFile: '.env',
  trailers: [],
  json: false,
  help: false,
  ...over,
})

type FleetGame = {
  build: { id: string } | null
  upstream: { repo: string; pinned: string; latest: string | null; publishedAt: string | null }[]
  providers: unknown[]
  recent: Record<string, unknown>[]
}

/** The box, faked: every hand the verb has, recording what it was asked. */
function box(over: Record<string, unknown> = {}) {
  const calls: string[] = []
  const files = new Map<string, string>([
    ['docker/cs2/Dockerfile', TREE.dockerfile],
    ['plugins/Directory.Build.props', TREE.props],
    ['apps/orchestrator/src/game/pins.ts', TREE.pinsTs],
    ['docs/pins.md', TREE.pinsMd],
  ])
  const committed = new Map(files)
  const writes: string[] = []
  const comments: { number: number; body: string }[] = []
  const lines: string[] = []
  const codes: Record<string, number> = {
    'dathost:image --check': 0,
    'check-pins': 0,
    'pnpm verify': 0,
    'cs2:build': 0,
    'cs2:canary': 0,
    'dathost:image': 0,
    ...((over.codes as Record<string, number>) ?? {}),
  }
  const canaryVerdicts = (over.canaryVerdicts as Record<string, string>) ?? {
    plain: 'green',
    hud: 'green',
  }
  const cs2Verdict = {
    build: '1.41.9.2',
    image: 'abc1234',
    boots: [
      { cssMs: 3000, readyMs: 13_000 },
      { cssMs: 4000, readyMs: 16_300 },
    ],
    rows: { retakes: 'green', 'pug-2v1': 'green' },
    state: 'green',
    reason: null,
  }
  let lock: { token: string; holder: string; pid: number; host: string; since: string } | null =
    (over.lock as typeof lock) ?? null
  let now = 1_764_000_000_000
  const game: FleetGame = (over.game as FleetGame) ?? {
    build: { id: '1.41.9.2' },
    upstream: [],
    providers: [],
    recent: [],
  }
  let runs = 0
  const existingComments: string[] = (over.existingComments as string[]) ?? []
  const deps = {
    clock: {
      now: () => now,
      sleep: async (ms: number) => {
        now += ms
      },
    },
    every: (_ms: number, _fn: () => void) => () => {},
    say: (line: string) => lines.push(line),
    env: {
      policy: (over.policy as string) ?? 'off',
      apiKey: 'k',
      publicUrl: null,
      baseUrl: null,
      githubToken: 't',
      githubRepo: 'ezpug/ezpug-iron',
    },
    day: '2026-10-24',
    tree: {
      status: () => (over.dirty as string) ?? '',
      read: (path: string) => files.get(path) as string,
      write: (path: string, text: string) => {
        writes.push(path)
        files.set(path, text)
      },
      restore: (paths: string[]) => {
        calls.push(`restore ${paths.length}`)
        for (const path of paths) files.set(path, committed.get(path) as string)
      },
      commit: (paths: string[], message: string) => {
        calls.push(`commit ${paths.join(',')}`)
        calls.push(`message ${message.split('\n')[0]}`)
        for (const path of paths) committed.set(path, files.get(path) as string)
        return 'c0ffee1'
      },
    },
    github: {
      enabled: (over.githubEnabled as boolean) ?? true,
      release: async (repo: string, tag: string) =>
        ((over.releases as Record<string, Release>) ?? RELEASES)[`${repo}#${tag}`] ?? null,
      submoduleSha: async (_repo: string, _path: string, ref: string) =>
        ref === 'v1.0.378' ? SUBMODULE_1_0_378 : ((over.submoduleSha as string | null) ?? null),
      metamodLatest: async () => (over.metamodLatest as string) ?? '2.0.0-git1483',
      issueFor: async (prefix: string) => {
        calls.push(`issueFor ${prefix}`)
        return { number: 14, url: 'https://github.com/ezpug/ezpug-iron/issues/14' }
      },
      comments: async () => existingComments,
      comment: async (number: number, body: string) => {
        comments.push({ number, body })
        return true
      },
    },
    download: async (url: string) => {
      calls.push(`download ${url.split('/').pop()}`)
      const sha256 = url.includes('MultiAddonManager-v1.7.1')
        ? ((over.mamSha as string) ?? SHA.mam171)
        : url.includes('mmsource-')
          ? SHA.metamod
          : url.includes('counterstrikesharp-with-runtime-linux-1.0.378')
            ? SHA.css
            : 'f'.repeat(64)
      return { sha256, path: `/scratch/${url.split('/').pop()}` }
    },
    metamodFacts: () => (over.metamodFacts as object) ?? { build: 1483, commits: ['170058a'] },
    run: async (label: string, _command: string, args: string[]) => {
      calls.push(
        `run ${label}${label === 'cs2:canary' ? ` ${args.filter(a => a.startsWith('--')).join(' ')}` : ''}`,
      )
      const code = codes[label] ?? 0
      if (label === 'cs2:canary') {
        if (code === 2)
          return {
            code,
            stdout:
              'cs2:canary refused (orchestrator): no dev orchestrator answers at http://127.0.0.1:3430\n',
          }
        const verdict =
          code === 0
            ? cs2Verdict
            : { ...cs2Verdict, state: 'red', reason: 'boot 2: Failed to find signature: …' }
        return { code, stdout: `${JSON.stringify(verdict)}\n` }
      }
      return { code, stdout: '' }
    },
    lane: {
      read: () => lock,
      take: async ({ what }: { what: string }) => {
        calls.push(`take ${what}`)
        if (over.laneHeld)
          throw new Error('the CS2 lane is still held by ezpug-platform (pid 7) after 45 minutes')
        lock = { token: 'tok-mine', holder: 'ezpug-iron', pid: 1, host: 'box', since: 'then' }
        return { entry: { token: 'tok-mine' } }
      },
      refresh: () => true,
      release: (token: string) => {
        calls.push(`release ${token}`)
        lock = null
        return true
      },
    },
    orchestrator: {
      game: async () => game,
      canary: async (provider: string, hud: boolean) => {
        runs += 1
        const matchId = `m-${runs}`
        calls.push(`canary ${provider} ${hud ? 'hud' : 'plain'}`)
        // The fake orchestrator decides at once: the verdict is on the next read.
        const state = canaryVerdicts[hud ? 'hud' : 'plain']
        game.recent.unshift({
          type: 'game.canary_verdict',
          provider,
          build: '1.41.9.2',
          hud,
          attempt: runs,
          matchId,
          state,
          reason: state === 'red' ? 'the match ended: ttl_expired' : null,
        })
        return { provider, build: '1.41.9.2', hud, attempt: runs, matchId, finishedAt: null }
      },
    },
  }
  return { deps, calls, files, committed, writes, comments, lines }
}

describe('the specs and the flags', () => {
  it('reads css@, metamod@ (as a build) and mam@', () => {
    expect(follow.parseSpec('css@1.0.378')).toEqual({ spec: 'css', version: '1.0.378' })
    expect(follow.parseSpec('metamod@1483')).toEqual({ spec: 'metamod', version: '2.0.0-git1483' })
    expect(follow.parseSpec('metamod@git1483').version).toBe('2.0.0-git1483')
    expect(follow.parseSpec('mam@1.7')).toEqual({ spec: 'mam', version: '1.7' })
  })

  it('refuses MatchZy, an unknown upstream and a Metamod alone, by name', () => {
    expect(() => follow.parseSpec('matchzy@1.4.33-ezpug.1')).toThrow(/never followed/)
    expect(() => follow.parseSpec('sourcemod@1.12')).toThrow(/no upstream is called sourcemod/)
    expect(() => follow.parseArgs(['metamod@1483'])).toThrow(/Metamod is never followed alone/)
    expect(() => follow.parseArgs(['--auto', 'mam@1.7'])).toThrow(/--auto decides/)
    expect(() => follow.parseArgs(['mam@1.7', '--target', 'nodes'])).toThrow(/--target is/)
    expect(() => follow.parseArgs([])).toThrow(/name a spec/)
  })

  it('reads the flags', () => {
    const parsed = follow.parseArgs([
      'css@1.0.378',
      'metamod@1483',
      '--dry-run',
      '--target',
      'template',
      '--rows',
      'retakes,hud-on',
      '--hud',
      '--env-file',
      '.env.production',
      '--trailer',
      'Co-Authored-By: X <x@y>',
    ])
    expect(parsed.specs).toEqual({ css: '1.0.378', metamod: '2.0.0-git1483' })
    expect(parsed.dryRun).toBe(true)
    expect(parsed.target).toBe('template')
    expect(parsed.rows).toEqual(['retakes', 'hud-on'])
    expect(parsed.hud).toBe(true)
    expect(parsed.envFile).toBe('.env.production')
    expect(parsed.trailers).toEqual(['Co-Authored-By: X <x@y>'])
  })

  it('reads only the names it needs out of an env file', () => {
    const env = follow.readFollowEnv(
      'EZPUG_IRON_GAME_FOLLOW=patch\nEZPUG_IRON_API_KEY=ezik_x\nEZPUG_IRON_DATABASE_URL=postgres://prod\nEZPUG_IRON_PUBLIC_URL=https://gs.ezpug.com\n',
    )
    expect(env).toEqual({
      policy: 'patch',
      apiKey: 'ezik_x',
      publicUrl: 'https://gs.ezpug.com',
      baseUrl: null,
      githubToken: null,
      githubRepo: 'ezpug/ezpug-iron',
    })
    expect(follow.readFollowEnv('').policy).toBe('off')
  })
})

describe('versions', () => {
  it('reads triples and Metamod builds', () => {
    expect(follow.versionTriple('1.0.378')).toEqual([1, 0, 378])
    expect(follow.versionTriple('1.7')).toEqual([1, 7, 0])
    expect(follow.versionTriple('1.4.32-ezpug.1')).toBeNull()
    expect(follow.metamodVersion('1483')).toBe('2.0.0-git1483')
    expect(follow.metamodVersion('2.0.0-git1483')).toBe('2.0.0-git1483')
    expect(follow.metamodVersion('abc')).toBeNull()
  })

  it('names the kind of a move', () => {
    expect(follow.bumpKind('1.0.376', '1.0.378')).toBe('patch')
    expect(follow.bumpKind('1.6.1', '1.6.2')).toBe('patch')
    expect(follow.bumpKind('1.7', '1.7.1')).toBe('patch')
    expect(follow.bumpKind('1.6.2', '1.7')).toBe('minor')
    expect(follow.bumpKind('1.0.378', '1.1.0')).toBe('minor')
    expect(follow.bumpKind('1.0.378', '2.0.0')).toBe('major')
    expect(follow.bumpKind('1.0.378', '1.0.378')).toBe('same')
    expect(follow.bumpKind('1.0.378', '1.0.376')).toBe('older')
    expect(follow.bumpKind('1.0.378', '1.4.32-ezpug.1')).toBe('unknown')
  })
})

describe('the policy of a patch (decision 39), against the real release JSON', () => {
  it('follows a CounterStrikeSharp patch whose notes fix a CS2 version', () => {
    const verdict = follow.patchPolicy(
      'css',
      '1.0.376',
      '1.0.378',
      rel('roflmuffin/CounterStrikeSharp#v1.0.378'),
    )
    expect(verdict.allowed).toBe(true)
    expect(verdict.why).toMatch(/is a patch/)
    expect(verdict.why).toMatch(/name CS2 1\.41\.9\.2/)
    expect(
      follow.patchPolicy('css', '1.0.375', '1.0.376', rel('roflmuffin/CounterStrikeSharp#v1.0.376'))
        .allowed,
    ).toBe(true)
    expect(
      follow.patchPolicy('css', '1.0.373', '1.0.375', rel('roflmuffin/CounterStrikeSharp#v1.0.375'))
        .allowed,
    ).toBe(true)
  })

  it('leaves a CounterStrikeSharp minor, a major, or notes that say breaking or migration to a human', () => {
    expect(
      follow.patchPolicy(
        'css',
        '1.0.378',
        '1.1.0',
        fictional('v1.1.0', '* fix: Game Update 1.42.0.1'),
      ),
    ).toMatchObject({
      allowed: false,
      kind: 'minor',
    })
    expect(
      follow.patchPolicy('css', '1.0.378', '2.0.0', fictional('v2.0.0', '* fix: everything')).kind,
    ).toBe('major')
    expect(
      follow.patchPolicy(
        'css',
        '1.0.378',
        '1.0.379',
        fictional('v1.0.379', '* BREAKING: the event model moved'),
      ).why,
    ).toMatch(/"breaking"/)
    expect(
      follow.patchPolicy(
        'css',
        '1.0.378',
        '1.0.379',
        fictional('v1.0.379', '* see the migration guide'),
      ).why,
    ).toMatch(/"migration"/)
    expect(
      follow.patchPolicy(
        'css',
        '1.0.378',
        '1.0.379',
        fictional('v1.0.379', '* removed the deprecated Timer API'),
      ).why,
    ).toMatch(/API/)
    expect(
      follow.patchPolicy('css', '1.0.378', '1.0.379', fictional('v1.0.379', '* chore: bump deps'))
        .why,
    ).toMatch(/neither name a CS2 version nor say "fix"/)
    expect(
      follow.patchPolicy(
        'css',
        '1.0.378',
        '1.0.379',
        fictional('v1.0.379', '* fix: Game Update 1.41.9.3'),
      ).allowed,
    ).toBe(true)
  })

  it('follows a MultiAddonManager patch by the third number alone, and waits on a minor', () => {
    expect(
      follow.patchPolicy('mam', '1.6.1', '1.6.2', rel('Source2ZE/MultiAddonManager#v1.6.2'))
        .allowed,
    ).toBe(true)
    expect(
      follow.patchPolicy('mam', '1.6.2', '1.7', rel('Source2ZE/MultiAddonManager#v1.7')),
    ).toMatchObject({
      allowed: false,
      kind: 'minor',
    })
    expect(
      follow.patchPolicy('mam', '1.7', '1.7.1', rel('Source2ZE/MultiAddonManager#v1.7.1')).allowed,
    ).toBe(true)
    expect(follow.patchPolicy('mam', '1.7.1', '1.8', null).why).toMatch(/minor.*waits for a human/)
  })

  it('never follows MatchZy-Enhanced, nor Metamod alone', () => {
    expect(
      follow.patchPolicy(
        'matchzy',
        '1.4.32-ezpug.1',
        '1.4.33-ezpug.1',
        rel('ezpug/MatchZy-Enhanced#v1.4.32-ezpug.1'),
      ),
    ).toMatchObject({
      allowed: false,
      kind: 'never',
    })
    expect(follow.patchPolicy('metamod', '2.0.0-git1483', '2.0.0-git1490').why).toMatch(
      /never followed alone/,
    )
  })

  it('reads a release headline: the first fix bullet when the title is only the tag', () => {
    expect(follow.releaseHeadline(rel('roflmuffin/CounterStrikeSharp#v1.0.378'))).toBe(
      'fix: Game Update 1.41.9.2 in #1470 (5465e2a)',
    )
    expect(follow.releaseHeadline(rel('Source2ZE/MultiAddonManager#v1.7'))).toBe(
      'Rebuilt for the 22/10/2026 CS2 update.',
    )
    expect(follow.releaseHeadline(rel('ezpug/MatchZy-Enhanced#v1.4.32-ezpug.1'))).toBe(
      'MatchZy-Enhanced 1.4.32-ezpug.1',
    )
  })
})

describe('the Metamod pair', () => {
  const binary = Buffer.from(
    ['', 'junk', '170058a', '2.0.0-dev+1483', 'more', ''].join('\0'),
    'latin1',
  )

  it('reads the build and the commit out of the binary', () => {
    expect(follow.metamodBinaryFacts(binary)).toEqual({ build: 1483, commits: ['170058a'] })
  })

  it('holds metamod@NNNN to the CounterStrikeSharp release’s submodule', () => {
    const facts = follow.metamodBinaryFacts(binary)
    expect(
      follow.metamodPairProblem({
        cssVersion: '1.0.378',
        submoduleSha: SUBMODULE_1_0_378,
        metamodVersion: '2.0.0-git1483',
        binary: facts,
      }),
    ).toBeNull()
    expect(
      follow.metamodPairProblem({
        cssVersion: '1.0.378',
        submoduleSha: SUBMODULE_1_0_378,
        metamodVersion: '2.0.0-git1490',
        binary: facts,
      }),
    ).toMatch(/says it is build 1483, not 1490/)
    expect(
      follow.metamodPairProblem({
        cssVersion: '1.0.378',
        submoduleSha: 'fa6f80e4deadbeef',
        metamodVersion: '2.0.0-git1483',
        binary: facts,
      }),
    ).toMatch(/not the pair/)
    expect(
      follow.metamodPairProblem({
        cssVersion: '1.0.378',
        submoduleSha: null,
        metamodVersion: '2.0.0-git1483',
        binary: facts,
      }),
    ).toMatch(/names no libraries\/metamod-source/)
  })
})

describe('the homes, rewritten on this tree', () => {
  it('moves MultiAddonManager in the Dockerfile, GAME_PINS and the pins.md row, and leaves the props alone', () => {
    const homes = follow.planHomes(
      TREE,
      [
        {
          spec: 'mam',
          from: PINNED.mam,
          to: '1.7.1',
          sha256: SHA.mam171,
          release: rel('Source2ZE/MultiAddonManager#v1.7.1'),
        },
      ],
      { day: '2026-10-24' },
    )
    expect(arg(home(homes, 'docker/cs2/Dockerfile').after, 'MULTIADDONMANAGER_VERSION')).toBe(
      '1.7.1',
    )
    expect(arg(home(homes, 'docker/cs2/Dockerfile').after, 'MULTIADDONMANAGER_SHA256')).toBe(
      SHA.mam171,
    )
    expect(arg(home(homes, 'docker/cs2/Dockerfile').after, 'COUNTER_STRIKE_SHARP_VERSION')).toBe(
      PINNED.css,
    )
    expect(home(homes, 'apps/orchestrator/src/game/pins.ts').after).toMatch(
      /multiAddonManager: '1\.7\.1',/,
    )
    expect(home(homes, 'plugins/Directory.Build.props').after).toBe(TREE.props)
    const row = home(homes, 'docs/pins.md')
      .after.split('\n')
      .find(l => l.startsWith('| MultiAddonManager | ')) as string
    expect(row).toContain('| `1.7.1`, `steamrt3` |')
    expect(row).toMatch(
      /1\.7\.1 \(2026-10-23\) is "Fixed regression where the plugin wouldn't mount addons in some cases\.", followed by `pnpm game:follow` on 2026-10-24 \|$/,
    )
    // The row's history stays.
    expect(row).toContain('1.7 (2026-10-23 10:55 UTC)')
  })

  it('moves CounterStrikeSharp in both its rows and the props, and Metamod with the release’s submodule', () => {
    const css = rel('roflmuffin/CounterStrikeSharp#v1.0.378')
    const homes = follow.planHomes(
      {
        ...TREE,
        dockerfile: TREE.dockerfile
          .replace(
            `ARG COUNTER_STRIKE_SHARP_VERSION=${PINNED.css}`,
            'ARG COUNTER_STRIKE_SHARP_VERSION=1.0.376',
          )
          .replace(`ARG METAMOD_VERSION=${PINNED.metamod}`, 'ARG METAMOD_VERSION=2.0.0-git1469'),
        pinsMd: TREE.pinsMd
          .replace(
            '| CounterStrikeSharp.API | `1.0.378` |',
            '| CounterStrikeSharp.API | `1.0.376` |',
          )
          .replace('| Metamod:Source | `2.0.0-git1483` |', '| Metamod:Source | `2.0.0-git1469` |')
          .replace(
            '| CounterStrikeSharp (the release) | `1.0.378`,',
            '| CounterStrikeSharp (the release) | `1.0.376`,',
          ),
        props: TREE.props.replace(
          '<CounterStrikeSharpApiVersion>1.0.378<',
          '<CounterStrikeSharpApiVersion>1.0.376<',
        ),
      },
      [
        {
          spec: 'css',
          from: '1.0.376',
          to: '1.0.378',
          sha256: SHA.css,
          release: css,
          submoduleSha: SUBMODULE_1_0_378,
        },
        {
          spec: 'metamod',
          from: '2.0.0-git1469',
          to: '2.0.0-git1483',
          sha256: SHA.metamod,
          release: null,
          submoduleSha: SUBMODULE_1_0_378,
        },
      ],
      { day: '2026-10-24', proof: 'cs2:canary green on CS2 1.41.9.2 (8 boots)' },
    )
    expect(home(homes, 'plugins/Directory.Build.props').after).toContain(
      '<CounterStrikeSharpApiVersion>1.0.378</CounterStrikeSharpApiVersion>',
    )
    expect(arg(home(homes, 'docker/cs2/Dockerfile').after, 'METAMOD_VERSION')).toBe('2.0.0-git1483')
    expect(arg(home(homes, 'docker/cs2/Dockerfile').after, 'METAMOD_SHA256')).toBe(SHA.metamod)
    const rows = home(homes, 'docs/pins.md').after.split('\n')
    expect(rows.find(l => l.startsWith('| CounterStrikeSharp.API | '))).toContain('| `1.0.378` |')
    const release = rows.find(l => l.startsWith('| CounterStrikeSharp (the release) | ')) as string
    expect(release).toContain('| `1.0.378`, `counterstrikesharp-with-runtime-linux` |')
    expect(release).toMatch(
      /1\.0\.378 \(2026-10-23, "fix: Game Update 1\.41\.9\.2 in #1470 \(5465e2a\)"\) is upstream's fix for CS2 1\.41\.9\.2, followed by `pnpm game:follow` on 2026-10-24 — cs2:canary green on CS2 1\.41\.9\.2 \(8 boots\) \|$/,
    )
    const metamod = rows.find(l => l.startsWith('| Metamod:Source | ')) as string
    expect(metamod).toContain('| `2.0.0-git1483` |')
    expect(metamod).toMatch(
      /For 1\.0\.378 that is commit `170058a2`, which is git1483 \(the binary says `2\.0\.0-dev\+1483`\), followed by/,
    )
  })

  it('refuses a row it cannot find or a pin cell that does not carry the old version', () => {
    expect(() =>
      follow.rewritePinsRow(TREE.pinsMd, 'Nothing Here', { from: '1', to: '2' }),
    ).toThrow(/no row "Nothing Here"/)
    expect(() =>
      follow.rewritePinsRow(TREE.pinsMd, 'MultiAddonManager', { from: '9.9', to: '9.9.1' }),
    ).toThrow(/does not carry `9\.9`/)
  })
})

describe('the run, on a faked box', () => {
  it('a dry run prints a byte-stable plan and touches nothing', async () => {
    const first = box()
    const second = box()
    const a = await follow.runFollow(options({ specs: { mam: '1.7.1' }, dryRun: true }), first.deps)
    const b = await follow.runFollow(
      options({ specs: { mam: '1.7.1' }, dryRun: true }),
      second.deps,
    )
    expect(a.action).toBe('dry-run')
    expect(a.plan).toBe(b.plan)
    expect(a.plan).toContain('MultiAddonManager: 1.7 → 1.7.1')
    expect(a.plan).toContain(`MultiAddonManager-v1.7.1-steamrt3.tar.gz sha256 ${SHA.mam171}`)
    expect(a.plan).toContain('+ ARG MULTIADDONMANAGER_VERSION=1.7.1')
    expect(a.plan).toContain('  phases:')
    expect(a.plan).toContain('    cs2:canary')
    expect(first.writes).toEqual([])
    expect(
      first.calls.filter(
        c => c.startsWith('run ') || c.startsWith('take ') || c.startsWith('commit'),
      ),
    ).toEqual([])
  })

  it('says nothing to do, per home, when the tree already carries the specs', async () => {
    const b = box()
    const report = await follow.runFollow(
      options({ specs: { css: PINNED.css, metamod: PINNED.metamod, mam: PINNED.mam } }),
      b.deps,
    )
    expect(report.action).toBe('nothing')
    expect(report.notes).toEqual(
      expect.arrayContaining([
        `CounterStrikeSharp is already ${PINNED.css}: nothing to do`,
        `Metamod:Source is already ${PINNED.metamod}: nothing to do`,
        `MultiAddonManager is already ${PINNED.mam}: nothing to do`,
      ]),
    )
    expect(report.plan).toContain('  phases:')
    expect(b.writes).toEqual([])
    // The pair was still checked: the drop was read for its binary.
    expect(b.calls).toContain('download mmsource-2.0.0-git1483-linux.tar.gz')
  })

  it('a green run walks every phase in order, holds the lane around the build and the boots, commits the homes and comments', async () => {
    const b = box()
    const report = await follow.runFollow(
      options({ specs: { mam: '1.7.1' }, trailers: ['Co-Authored-By: T <t@x>'] }),
      b.deps,
    )
    expect(report.action).toBe('followed')
    expect(report.phases).toEqual([
      'preflight',
      'resolve',
      'template-check',
      'homes',
      'check-pins',
      'verify',
      'lane',
      'cs2:build',
      'cs2:canary',
      'dathost:image',
      'canary',
      'commit',
      'issue',
    ])
    expect(b.calls.filter(c => c.startsWith('run '))).toEqual([
      'run dathost:image --check',
      'run check-pins',
      'run pnpm verify',
      'run cs2:build',
      'run cs2:canary --json --lock-token --rows',
      'run dathost:image',
      'run dathost:image --check',
    ])
    const take = b.calls.indexOf('take game:follow mam@1.7.1 (PRD-10 T5)')
    const release = b.calls.indexOf('release tok-mine')
    expect(take).toBeGreaterThan(b.calls.indexOf('run pnpm verify'))
    expect(release).toBeGreaterThan(b.calls.indexOf('run cs2:canary --json --lock-token --rows'))
    expect(release).toBeLessThan(b.calls.indexOf('run dathost:image'))
    expect(b.calls).toContain('canary dathost plain')
    expect(b.calls).not.toContain('canary dathost hud')
    expect(b.calls).toContain(`commit ${follow.HOMES.join(',')}`)
    expect(b.calls).toContain('message chore(pins): MultiAddonManager 1.7.1')
    expect(report.commit).toBe('c0ffee1')
    expect(report.proof).toEqual([
      'cs2:canary green on CS2 1.41.9.2 with image abc1234: 2 boots (server_ready 13.0–16.3 s); rows retakes green, pug-2v1 green',
      'Dathost canary green on build 1.41.9.2 (attempt 1)',
    ])
    expect(report.image).toBe('proven')
    expect(report.template).toBe('proven')
    // The committed row carries the proof; the Dockerfile carries the sha.
    const row = (b.committed.get('docs/pins.md') as string)
      .split('\n')
      .find(l => l.startsWith('| MultiAddonManager | ')) as string
    expect(row).toContain(
      'followed by `pnpm game:follow` on 2026-10-24 — cs2:canary green on CS2 1.41.9.2',
    )
    expect(
      arg(b.committed.get('docker/cs2/Dockerfile') as string, 'MULTIADDONMANAGER_SHA256'),
    ).toBe(SHA.mam171)
    expect(b.comments).toHaveLength(1)
    expect(b.comments[0]?.body).toContain(
      '**Followed:** `pnpm game:follow mam@1.7.1` committed `c0ffee1`',
    )
    expect(b.comments[0]?.body).toContain('Dathost canary green')
    expect(report.issue).toMatchObject({ commented: true, number: 14 })
  })

  it('plays the hud canary too when asked, and derives Metamod from the release when css comes alone', async () => {
    const b = box()
    const report = await follow.runFollow(
      options({ specs: { css: '1.0.378', mam: '1.7.1' }, hud: true }),
      b.deps,
    )
    expect(report.action).toBe('followed')
    expect(b.calls).toContain('canary dathost hud')
    expect(report.notes).toContain(
      "metamod@1483 is the drop's newest build; held to the release's submodule below",
    )
  })

  const stops = async (over: Record<string, unknown>, opts: Partial<Options> = {}) => {
    const b = box(over)
    let stop: (Error & { phase: string }) | null = null
    try {
      await follow.runFollow(options({ specs: { mam: '1.7.1' }, ...opts }), b.deps)
    } catch (error) {
      stop = error as Error & { phase: string }
    }
    expect(stop).toBeInstanceOf(follow.Stop)
    return { b, stop: stop as Error & { phase: string } }
  }

  it('stops by name: a dirty tree, before anything', async () => {
    const { b, stop } = await stops({ dirty: ' M apps/orchestrator/src/x.ts\n?? y\n' })
    expect(stop.phase).toBe('preflight')
    expect(stop.message).toMatch(/the tree is dirty \(2 paths\)/)
    expect(b.writes).toEqual([])
  })

  it('stops by name: a sha that is not the release page’s', async () => {
    const { b, stop } = await stops({ mamSha: 'a'.repeat(64) })
    expect(stop.phase).toBe('resolve')
    expect(stop.message).toMatch(/release page says sha256:d40dc64a/)
    expect(b.writes).toEqual([])
  })

  it('stops by name: a Metamod that is not the pair CounterStrikeSharp names', async () => {
    const { stop } = await stops({}, { specs: { css: '1.0.378', metamod: '2.0.0-git1490' } })
    expect(stop.phase).toBe('resolve')
    expect(stop.message).toMatch(/build 1483, not 1490/)
  })

  it('stops by name: a template whose --check was red before the push, with nothing written', async () => {
    const { b, stop } = await stops({ codes: { 'dathost:image --check': 1 } })
    expect(stop.phase).toBe('template-check')
    expect(stop.message).toMatch(/somebody’s hand is on it/)
    expect(b.writes).toEqual([])
  })

  it('stops by name: a red verify, and the homes are back at the last commit', async () => {
    const { b, stop } = await stops({ codes: { 'pnpm verify': 1 } })
    expect(stop.phase).toBe('verify')
    expect(b.writes.length).toBeGreaterThan(0)
    expect(b.calls).toContain('restore 4')
    expect(b.files.get('docker/cs2/Dockerfile')).toBe(TREE.dockerfile)
    expect(b.calls.find(c => c.startsWith('take '))).toBeUndefined()
  })

  it('stops by name: a lane held past the wait', async () => {
    const { b, stop } = await stops({ laneHeld: true })
    expect(stop.phase).toBe('lane')
    expect(stop.message).toMatch(/held by ezpug-platform/)
    expect(b.files.get('docker/cs2/Dockerfile')).toBe(TREE.dockerfile)
  })

  it('stops by name: a red dev-node canary, the lane given back, the template untouched', async () => {
    const { b, stop } = await stops({ codes: { 'cs2:canary': 1 } })
    expect(stop.phase).toBe('cs2:canary')
    expect(stop.message).toMatch(/cs2:canary red .* Failed to find signature/)
    expect(b.calls).toContain('release tok-mine')
    expect(b.calls).not.toContain('run dathost:image')
    expect(b.files.get('docs/pins.md')).toBe(TREE.pinsMd)
  })

  it('assisted, a refused dev-node canary stops the verb; unattended it falls to the template alone and says so', async () => {
    const { stop } = await stops({ codes: { 'cs2:canary': 2 } })
    expect(stop.phase).toBe('cs2:canary')
    expect(stop.message).toMatch(/judged nothing: no dev orchestrator answers/)

    const b = box({ codes: { 'cs2:canary': 2 } })
    const report = await follow.runFollow(options({ specs: { mam: '1.7.1' }, auto: true }), b.deps)
    expect(report.action).toBe('followed')
    expect(report.target).toBe('template')
    expect(report.image).toBe('rebuilt')
    expect(report.template).toBe('proven')
    expect(report.notes.join('\n')).toMatch(
      /the follow is the template's alone: no dev orchestrator answers/,
    )
    const row = (b.committed.get('docs/pins.md') as string)
      .split('\n')
      .find(l => l.startsWith('| MultiAddonManager | ')) as string
    expect(row).toContain('Dathost-proven, unproven for LAN nodes')
    expect(b.comments[0]?.body).toContain("the follow is the template's alone")
  })

  it('stops by name: a red Dathost canary, after the template was refreshed, and says what that means', async () => {
    const { b, stop } = await stops({ canaryVerdicts: { plain: 'red', hud: 'green' } })
    expect(stop.phase).toBe('canary')
    expect(stop.message).toMatch(
      /the Dathost canary is red on build 1\.41\.9\.2 \(attempt 1\): the match ended: ttl_expired/,
    )
    expect(b.calls).toContain('restore 4')
    expect(b.lines.join('\n')).toMatch(
      /the template was refreshed with the new pins before the stop/,
    )
    expect(b.calls.find(c => c.startsWith('commit '))).toBeUndefined()
  })

  it('a lock token it is handed is checked, used for the boots and never released', async () => {
    const lock = { token: 'tok-theirs', holder: 'ezpug-iron', pid: 9, host: 'box', since: 'then' }
    const b = box({ lock })
    const report = await follow.runFollow(
      options({ specs: { mam: '1.7.1' }, lockToken: 'tok-theirs' }),
      b.deps,
    )
    expect(report.action).toBe('followed')
    expect(b.calls.find(c => c.startsWith('take ') || c.startsWith('release '))).toBeUndefined()

    const wrong = box({ lock })
    let stop: (Error & { phase: string }) | null = null
    try {
      await follow.runFollow(
        options({ specs: { mam: '1.7.1' }, lockToken: 'tok-mine' }),
        wrong.deps,
      )
    } catch (error) {
      stop = error as Error & { phase: string }
    }
    expect(stop?.phase).toBe('lane')
  })

  it('writes a commit message that names the move, the policy and the proof, with the trailer last', () => {
    const message = follow.commitMessage({
      bumps: [
        {
          spec: 'mam',
          from: '1.7',
          to: '1.7.1',
          release: rel('Source2ZE/MultiAddonManager#v1.7.1'),
          policy: follow.patchPolicy('mam', '1.7', '1.7.1'),
        },
      ],
      specs: { mam: '1.7.1' },
      proof: ['Dathost canary green on build 1.41.9.2 (attempt 4)'],
      target: 'both',
      day: '2026-10-24',
      notes: [],
      trailers: ['Co-Authored-By: T <t@x>'],
    })
    expect(message.split('\n')[0]).toBe('chore(pins): MultiAddonManager 1.7.1')
    expect(message).toContain(
      '- MultiAddonManager 1.7 → 1.7.1 (Source2ZE/MultiAddonManager v1.7.1, 2026-10-23T23:12:21Z): "Fixed regression where the plugin wouldn\'t mount addons in some cases." — a patch by the policy',
    )
    expect(message).toContain('Proof:\n- Dathost canary green on build 1.41.9.2 (attempt 4)')
    expect(message.trimEnd().endsWith('Co-Authored-By: T <t@x>')).toBe(true)
  })
})

describe('--auto, under the policy', () => {
  const picture = (upstream: FleetGame['upstream']): FleetGame => ({
    build: { id: '1.41.9.2' },
    upstream,
    providers: [],
    recent: [],
  })
  const releaseOf = async (spec: string, version: string): Promise<Release | null> => {
    if (spec === 'css' && version === '1.1.0')
      return fictional('v1.1.0', '* fix: Game Update 1.42.0.1')
    if (spec === 'css' && version === '1.0.379')
      return fictional('v1.0.379', '* fix: Game Update 1.41.9.3')
    const repo =
      spec === 'css'
        ? 'roflmuffin/CounterStrikeSharp'
        : spec === 'mam'
          ? 'Source2ZE/MultiAddonManager'
          : 'ezpug/MatchZy-Enhanced'
    return RELEASES[`${repo}#v${version}`] ?? null
  }

  it('off: nothing, whatever the watcher saw', async () => {
    const decision = await follow.autoDecision({
      policy: 'off',
      game: picture([
        { repo: 'Source2ZE/MultiAddonManager', pinned: '1.7', latest: '1.7.1', publishedAt: null },
      ]),
      releaseOf,
    })
    expect(decision).toMatchObject({ action: 'off', specs: {}, waiting: [] })
    expect(decision.why).toContain('EZPUG_IRON_GAME_FOLLOW=off')
  })

  it('patch: follows the MultiAddonManager 1.7.1 the watcher saw, says nothing of the upstreams that did not move', async () => {
    const decision = await follow.autoDecision({
      policy: 'patch',
      game: picture([
        {
          repo: 'roflmuffin/CounterStrikeSharp',
          pinned: '1.0.378',
          latest: null,
          publishedAt: null,
        },
        {
          repo: 'alliedmodders/metamod-source',
          pinned: '2.0.0-git1483',
          latest: null,
          publishedAt: null,
        },
        {
          repo: 'Source2ZE/MultiAddonManager',
          pinned: '1.7',
          latest: '1.7.1',
          publishedAt: '2026-10-23T23:12:21Z',
        },
        {
          repo: 'ezpug/MatchZy-Enhanced',
          pinned: '1.4.32-ezpug.1',
          latest: null,
          publishedAt: null,
        },
      ]),
      releaseOf,
    })
    expect(decision).toMatchObject({ action: 'follow', specs: { mam: '1.7.1' }, waiting: [] })
  })

  it('patch: a fictional css 1.0.379 "Game Update" follows; a 1.1.0, a mam 1.8 and a MatchZy tag wait for a human', async () => {
    const allowed = await follow.autoDecision({
      policy: 'patch',
      game: picture([
        {
          repo: 'roflmuffin/CounterStrikeSharp',
          pinned: '1.0.378',
          latest: '1.0.379',
          publishedAt: null,
        },
      ]),
      releaseOf,
    })
    expect(allowed).toMatchObject({ action: 'follow', specs: { css: '1.0.379' } })

    const waiting = await follow.autoDecision({
      policy: 'patch',
      game: picture([
        {
          repo: 'roflmuffin/CounterStrikeSharp',
          pinned: '1.0.378',
          latest: '1.1.0',
          publishedAt: null,
        },
        { repo: 'Source2ZE/MultiAddonManager', pinned: '1.7.1', latest: '1.8', publishedAt: null },
        {
          repo: 'ezpug/MatchZy-Enhanced',
          pinned: '1.4.32-ezpug.1',
          latest: '1.4.33-ezpug.1',
          publishedAt: null,
        },
        {
          repo: 'alliedmodders/metamod-source',
          pinned: '2.0.0-git1483',
          latest: '2.0.0-git1490',
          publishedAt: null,
        },
      ]),
      releaseOf,
    })
    expect(waiting.action).toBe('nothing')
    expect(waiting.waiting.map(w => `${w.repo}@${w.version}`)).toEqual([
      'roflmuffin/CounterStrikeSharp@1.1.0',
      'Source2ZE/MultiAddonManager@1.8',
      'ezpug/MatchZy-Enhanced@1.4.33-ezpug.1',
      'alliedmodders/metamod-source@2.0.0-git1490',
    ])
    expect(waiting.waiting[0]?.why).toMatch(/is a minor/)
    expect(waiting.waiting[2]?.why).toMatch(/never followed/)
    expect(waiting.waiting[3]?.why).toMatch(/never followed alone/)
  })

  it('runAuto: off does nothing; patch comments "waiting for a human" once and follows what is allowed', async () => {
    const off = box({
      policy: 'off',
      game: picture([
        { repo: 'Source2ZE/MultiAddonManager', pinned: '1.7', latest: '1.7.1', publishedAt: null },
      ]),
    })
    const offReport = await follow.runAuto(options({ auto: true }), off.deps)
    expect(offReport.action).toBe('off')
    expect(off.calls).toEqual([])

    const game = picture([
      {
        repo: 'roflmuffin/CounterStrikeSharp',
        pinned: '1.0.378',
        latest: '1.1.0',
        publishedAt: null,
      },
      { repo: 'Source2ZE/MultiAddonManager', pinned: '1.7', latest: '1.7.1', publishedAt: null },
    ])
    const releases = {
      ...RELEASES,
      'roflmuffin/CounterStrikeSharp#v1.1.0': fictional('v1.1.0', '* fix: Game Update 1.42.0.1'),
    }
    const b = box({ policy: 'patch', game, releases })
    const report = await follow.runAuto(options({ auto: true }), b.deps)
    expect(report.action).toBe('follow')
    expect(report.follow?.action).toBe('followed')
    expect(report.follow?.commit).toBe('c0ffee1')
    expect(b.comments[0]?.body).toContain(
      '**Waiting for a human:** roflmuffin/CounterStrikeSharp `1.1.0` — CounterStrikeSharp 1.0.378 → 1.1.0 is a minor',
    )
    expect(b.comments[0]?.body).toContain(
      `<!-- ${follow.WAITING_MARKER} roflmuffin/CounterStrikeSharp@1.1.0 -->`,
    )
    expect(b.comments[1]?.body).toContain('**Followed:** `pnpm game:follow mam@1.7.1`')

    // A second run finds the marker and says nothing twice.
    const again = box({
      policy: 'patch',
      game: picture([
        {
          repo: 'roflmuffin/CounterStrikeSharp',
          pinned: '1.0.378',
          latest: '1.1.0',
          publishedAt: null,
        },
      ]),
      releases,
      existingComments: [b.comments[0]?.body ?? ''],
    })
    const second = await follow.runAuto(options({ auto: true }), again.deps)
    expect(second.action).toBe('nothing')
    expect(again.comments).toEqual([])
  })

  it('runAuto --dry-run prints the plan it would run and names the policy that allowed it, commenting nothing', async () => {
    const b = box({
      policy: 'patch',
      game: picture([
        { repo: 'Source2ZE/MultiAddonManager', pinned: '1.7', latest: '1.7.1', publishedAt: null },
      ]),
    })
    const report = await follow.runAuto(options({ auto: true, dryRun: true }), b.deps)
    expect(report.why).toBe('the policy allows mam@1.7.1')
    expect(report.follow?.action).toBe('dry-run')
    expect(report.follow?.plan).toContain(
      'MultiAddonManager: 1.7 → 1.7.1 (released 2026-10-23T23:12:21Z) — MultiAddonManager 1.7 → 1.7.1 is a patch: the third number alone moved',
    )
    expect(b.writes).toEqual([])
    expect(b.comments).toEqual([])
  })
})
