import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { flattenRoutes, matchApiRoutes, matchRoutePath } from '@ezpug/match-api'
import { describe, expect, it } from 'vitest'

/**
 * **The docs, held against the thing they describe** (PRD-02 T38: "every doc
 * checked by a test where it names a route, a command or a version").
 *
 * The two doc tests that already exist look *outwards* from one artifact —
 * `apps/cli/src/docs.test.ts` asks whether the runbook covers every verb the
 * CLI has, `apps/node/src/docs.test.ts` whether it covers every variable the
 * agent reads. This one looks the other way, over the whole doc set at once:
 * a route a doc names has to exist, a command a doc tells a stranger to type
 * has to run, a version a doc states has to be the one its home holds. That
 * is the direction that rots. A route renamed, a script dropped or a pin
 * bumped in `package.json` leaves a sentence behind that reads perfectly and
 * is a lie, and the readers of a public repo have no way to tell.
 *
 * `packages/match-api/src/routes.test.ts` covers the forward direction for
 * routes (every route has a section in `docs/match-api.md`) and
 * `scripts/check-pins.mjs` covers the pin table itself; neither is repeated.
 *
 * It reads files. Nothing here starts a server.
 */

const repo = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), 'utf8')

/** Everything written for a stranger: the entry points, the reference, the runbooks. */
const DOCS = [
  'README.md',
  'CHANGELOG.md',
  'docs/match-api.md',
  'docs/gamemodes.md',
  'docs/sdk.md',
  'docs/nodes.md',
  'docs/operations.md',
  'docs/pins.md',
  'docs/decisions.md',
  'ralph/DEPLOY.md',
] as const

const docs: ReadonlyArray<readonly [string, string]> = DOCS.map(doc => [doc, repo(doc)])

const routePaths = flattenRoutes(matchApiRoutes).map(({ route }) => route.path)

describe('every route a doc names', () => {
  /**
   * A doc writes a path the way a person says it: `:id` where the table says
   * `:serverId`, `dathost` where the table says `:providerId`, a trailing `…`
   * for a whole family of them. `matchRoutePath` is the orchestrator's own
   * matcher and it takes any of those — a `:param` segment in the pattern
   * matches whatever a doc put there — so a path that trails off only has to
   * be some real route's prefix, and every other one has to *be* a route.
   */
  it('is a route the Match API actually serves', () => {
    for (const [doc, body] of docs) {
      const named = new Set(
        [...body.matchAll(/\/v1\/[A-Za-z0-9:_/-]*…?/g)]
          .map(match => match[0])
          // `https://dot.net/v1/dotnet-install.sh` is a URL, not one of ours.
          .filter(path => !path.startsWith('/v1/dotnet-install')),
      )
      for (const path of named) {
        const trailing = path.endsWith('…') || path.endsWith('/')
        const wanted = path.replace(/[…/]+$/, '')
        const depth = wanted.split('/').length
        const hit = routePaths.some(
          pattern =>
            matchRoutePath(
              trailing ? pattern.split('/').slice(0, depth).join('/') : pattern,
              wanted,
            ) !== null,
        )
        expect(hit, `${doc} names ${path}, which is no route of ours`).toBe(true)
      }
    }
  })
})

/**
 * The shell lines inside fenced blocks: what a stranger is actually told to
 * type, as opposed to prose that happens to contain the word `pnpm`. Every
 * fence is matched, not just the shell ones, so that openers and closers pair
 * up — filtering to `sh` in the pattern would make the *closing* fence of a
 * `json` block read as an opener and swallow the paragraph after it.
 */
const SHELL_FENCES = new Set(['', 'sh', 'bash', 'console'])
const fencedLines = (body: string): readonly string[] =>
  [...body.matchAll(/```(\w*)\n([\s\S]*?)```/g)]
    .filter(block => SHELL_FENCES.has(block[1] ?? ''))
    .flatMap(block => (block[2] ?? '').split('\n'))

/**
 * Every workspace package's scripts, by package name — `pnpm --filter
 * @ezpug/orchestrator keys:mint` is a script of *that* package's, and the
 * README hands it to a stranger as the first key of a fresh database.
 */
const workspaceScripts = (): ReadonlyMap<string, readonly string[]> => {
  const roots = ['apps', 'packages'].flatMap(dir =>
    readdirSync(fileURLToPath(new URL(`../../../${dir}`, import.meta.url))).map(
      entry => `${dir}/${entry}`,
    ),
  )
  const found = new Map<string, readonly string[]>()
  for (const dir of [...roots, 'plugins', 'gamemode-kit', 'gamemodes', '.']) {
    const manifest = JSON.parse(repo(`${dir}/package.json`)) as {
      name?: string
      scripts?: Record<string, string>
    }
    if (manifest.name) found.set(manifest.name, Object.keys(manifest.scripts ?? {}))
  }
  return found
}

describe('every command a doc tells a stranger to type', () => {
  const byPackage = workspaceScripts()
  const root = Object.keys(
    (JSON.parse(repo('package.json')) as { scripts: Record<string, string> }).scripts,
  )
  /** pnpm's own verbs, which are not any package's scripts. */
  const pnpmBuiltins = new Set(['install', 'exec', 'run', 'add', 'dlx', 'why', 'deploy', 'pack'])

  it('is a script the package it is filtered to has, when it is a `pnpm` one', () => {
    for (const [doc, body] of docs)
      for (const line of fencedLines(body))
        for (const match of line.matchAll(
          /\bpnpm (?:--silent )?(?:--filter (\S+) )?(?:--silent )?([a-z][a-z0-9:._-]*)/g,
        )) {
          const filter = match[1]
          const name = match[2] ?? ''
          if (pnpmBuiltins.has(name)) continue
          const scripts = filter ? byPackage.get(filter) : root
          expect(
            scripts,
            `${doc}: \`pnpm --filter ${filter}\` is no workspace package`,
          ).toBeDefined()
          expect(
            scripts,
            `${doc}: \`pnpm ${filter ? `--filter ${filter} ` : ''}${name}\``,
          ).toContain(name)
        }
  })

  it('is a verb `ezpug-node` has, when it is the agent’s', () => {
    const usage = repo('apps/node/src/cli.ts')
    // `docker exec ezpug-node node …` names the *container*; the binary is
    // the one at the start of a line or after a shell prompt.
    for (const [doc, body] of docs)
      for (const match of body.matchAll(/(?<!exec )ezpug-node ([a-z][a-z-]*)/g))
        expect(usage, `${doc}: \`ezpug-node ${match[1]}\``).toContain(`ezpug-node ${match[1]}`)
  })

  it('is a step `deploy.sh` has, when it is the deploy', () => {
    const deploy = repo('scripts/deploy.sh')
    for (const [doc, body] of docs)
      for (const match of body.matchAll(/deploy\.sh ([a-z][a-z-]*)/g))
        expect(deploy, `${doc}: \`deploy.sh ${match[1]}\``).toContain(match[1])
  })
})

describe('every version a doc states', () => {
  const manifest = JSON.parse(repo('package.json')) as {
    engines: { node: string }
    packageManager: string
  }
  const dotnet = (JSON.parse(repo('plugins/global.json')) as { sdk: { version: string } }).sdk
    .version

  it('is the toolchain its home pins (the README installs it, `docs/pins.md` tabulates it)', () => {
    for (const doc of ['README.md', 'docs/pins.md'] as const)
      expect(repo(doc), `${doc} states the Node range`).toContain(manifest.engines.node)
    expect(repo('docs/pins.md')).toContain(manifest.packageManager.replace('pnpm@', ''))
    expect(repo('docs/pins.md')).toContain(dotnet)
    // The README installs the SDK by channel, and the channel has to be that version's.
    expect(repo('README.md')).toContain(`--channel ${dotnet.split('.').slice(0, 2).join('.')}`)
  })

  it('is the contract’s own, where a doc quotes the package version', () => {
    const version = (JSON.parse(repo('packages/match-api/package.json')) as { version: string })
      .version
    expect(repo('packages/match-api/CHANGELOG.md'), 'the released version has a section').toContain(
      `## ${version} —`,
    )
    expect(repo('README.md'), 'the README quotes the version it ships').toContain(version)
  })

  it('is a tag the release pipeline knows, where `CHANGELOG.md` lists one', () => {
    const images = repo('scripts/release-image.mjs')
    const workflows = {
      'match-api': repo('.github/workflows/release.yml'),
      plugins: repo('.github/workflows/plugins.yml'),
    } as const
    const listed = [...repo('CHANGELOG.md').matchAll(/`([a-z0-9-]+)@x\.y\.z`/g)].map(
      m => m[1] ?? '',
    )
    expect(listed.length, 'the changelog names the tags').toBe(5)
    for (const artifact of listed) {
      if (artifact in workflows) {
        expect(workflows[artifact as keyof typeof workflows]).toContain(`${artifact}@`)
        continue
      }
      expect(images, `CHANGELOG.md lists ${artifact}@x.y.z`).toContain(`  ${artifact}: {`)
    }
  })
})
