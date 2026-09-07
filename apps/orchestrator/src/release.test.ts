import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * **The release pipeline, held against the files that describe it** (PRD-02
 * T34). Five tags publish five artifacts — the npm package, three images and
 * the plugin zip — and the only thing that decides what an image tag means is
 * `scripts/release-image.mjs`. This runs that script the way the workflow does
 * (its CLI, not its exports, because the workflow only has the CLI) and holds
 * the workflows, `docs/pins.md`, `docs/operations.md` and the README against it.
 *
 * It reads files and runs one node process; nothing here talks to a registry.
 * The pipeline itself is proved by pushing a tag, and by the `workflow_dispatch`
 * dry run that builds without publishing. It lives here for the same reason
 * `image.test.ts` and `cs2-image.test.ts` do: this package is the repo's Vitest
 * home for holding an artifact against its documentation.
 */

const repoUrl = (path: string): string =>
  fileURLToPath(new URL(`../../../${path}`, import.meta.url))
const repo = (path: string): string => readFileSync(repoUrl(path), 'utf8')

const workflow = (name: string): string => repo(`.github/workflows/${name}.yml`)

const verify = workflow('verify')
const images = workflow('images')
const plugins = workflow('plugins')
const release = workflow('release')
const pins = repo('docs/pins.md')
const operations = repo('docs/operations.md')
const readme = repo('README.md')

/** `release-image.mjs plan <ref>`, parsed the way `$GITHUB_OUTPUT` would be. */
const plan = (reference: string): Record<string, string> => {
  const output = execFileSync('node', ['scripts/release-image.mjs', 'plan', reference], {
    cwd: repoUrl(''),
    encoding: 'utf8',
  })
  return Object.fromEntries(
    output
      .split('\n')
      .filter(line => line.length > 0)
      .map(line => {
        const at = line.indexOf('=')
        return [line.slice(0, at), line.slice(at + 1)]
      }),
  )
}

type Build = { platform: string; runner: string; slug: string }
const builds = (planned: Record<string, string>): Build[] =>
  JSON.parse(planned.builds ?? '[]') as Build[]

/** The image names the script itself admits to, which is what everything else is checked against. */
const published = execFileSync('node', ['scripts/release-image.mjs', 'images'], {
  cwd: repoUrl(''),
  encoding: 'utf8',
})
  .split('\n')
  .filter(line => line.length > 0)

describe('the release tags', () => {
  it('publishes exactly the images the table names, from a Dockerfile that exists', () => {
    expect(published).toEqual([
      'ghcr.io/ezpug/ezpug-iron/orchestrator',
      'ghcr.io/ezpug/ezpug-iron/node',
      'ghcr.io/ezpug/ezpug-iron/cs2',
    ])
    for (const image of published) {
      const name = image.split('/').pop() as string
      const planned = plan(`${name}@1.2.3`)
      expect(planned.image).toBe(image)
      expect(existsSync(repoUrl(planned.dockerfile as string))).toBe(true)
      // Every image tag is a trigger of the one workflow that builds images.
      expect(images).toContain(`'${name}@*'`)
    }
  })

  it('builds each platform on its own native runner, and the game server on amd64 alone', () => {
    for (const name of ['orchestrator', 'node']) {
      const platforms = builds(plan(`${name}@1.2.3`))
      expect(platforms.map(build => build.platform)).toEqual(['linux/amd64', 'linux/arm64'])
      // Native, not emulated: two platforms, two different runners.
      expect(new Set(platforms.map(build => build.runner)).size).toBe(2)
      // An artifact name carries the digest back and may not contain a slash.
      for (const build of platforms) expect(build.slug).not.toContain('/')
    }
    // Valve ships no arm64 dedicated server, so there is nothing to put in the image.
    expect(builds(plan('cs2@1.2.3')).map(build => build.platform)).toEqual(['linux/amd64'])
  })

  it('moves `latest` for a release and never for a prerelease', () => {
    const stable = plan('orchestrator@1.2.3').tags?.split(',')
    expect(stable).toEqual([
      'ghcr.io/ezpug/ezpug-iron/orchestrator:1.2.3',
      'ghcr.io/ezpug/ezpug-iron/orchestrator:1.2',
      'ghcr.io/ezpug/ezpug-iron/orchestrator:latest',
    ])
    expect(plan('orchestrator@1.2.3-rc.1').tags).toBe(
      'ghcr.io/ezpug/ezpug-iron/orchestrator:1.2.3-rc.1',
    )
  })

  it('is a dry run when no version is named, and pushes nothing', () => {
    const dispatched = plan('cs2')
    expect(dispatched.push).toBe('false')
    expect(dispatched.version).toBe('')
    expect(dispatched.tags).toBe('')
    // The same build, only the push is missing.
    expect(builds(dispatched)).toEqual(builds(plan('cs2@1.2.3')))
    // …which is the one flag every job after the plan reads.
    expect(images).toContain("needs.plan.outputs.push == 'true'")
  })

  it('refuses a tag that is not an image at a version', () => {
    for (const bad of ['orchestra@1.2.3', 'cs2@banana', 'cs2@1.2']) {
      expect(() => plan(bad)).toThrow()
    }
  })
})

describe('the workflows', () => {
  it('gate every publish on the one definition of green', () => {
    // `verify.yml` is reusable so a tag runs exactly what a pull request ran.
    expect(verify).toMatch(/^ {2}workflow_call:$/m)
    for (const gated of [images, plugins]) {
      expect(gated).toContain('uses: ./.github/workflows/verify.yml')
    }
    // The package's own gate is the heavier one: the conformance suite.
    expect(release).toContain('release.mjs publish')
  })

  it('write a human-readable image tag once, over the digests, and never twice', () => {
    // Per-platform builds push by digest; only the merge job writes a tag.
    expect(images).toContain('push-by-digest=true')
    expect(images).toContain('docker buildx imagetools create')
    expect(images).toContain('is already published — release a new version instead')
    // The provenance attestation is on the manifest list the tags point at.
    expect(images).toContain('actions/attest-build-provenance')
  })

  it('label an image with the commit it was built from', () => {
    expect(images).toContain('build-args: EZPUG_GIT_SHA=')
    for (const dockerfile of ['orchestrator', 'node']) {
      expect(repo(`docker/${dockerfile}/Dockerfile`)).toContain(
        'LABEL org.opencontainers.image.revision=$EZPUG_GIT_SHA',
      )
    }
  })

  it('hold a `plugins@` tag against the version the plugin itself carries', () => {
    expect(plugins).toContain("tags: ['plugins@*']")
    expect(plugins).toContain('./plugins/publish.sh dist')
    expect(plugins).toContain('build.json')
    expect(plugins).toContain('gh release upload')
    // The home of that number, which the tag is only a copy of.
    expect(repo('plugins/EZPug.Core/EZPug.Core.csproj')).toMatch(/<Version>\d+\.\d+\.\d+</)
  })
})

describe('what a reader is told', () => {
  it('records every image, and every platform it is built for, in docs/pins.md', () => {
    // The same check `pnpm lint` runs (scripts/check-pins.mjs), from the other side.
    for (const image of published) expect(pins).toContain(`\`${image}\``)
    for (const platform of ['linux/amd64', 'linux/arm64']) expect(pins).toContain(`\`${platform}\``)
    // Who pins one, which is the question the section exists to answer.
    expect(pins).toContain('EZPUG_IRON_IMAGE')
  })

  it('names every release tag where an operator and a stranger each look', () => {
    for (const tag of ['match-api@', 'orchestrator@', 'node@', 'cs2@', 'plugins@']) {
      expect(operations).toContain(tag)
      expect(readme).toContain(tag)
    }
    expect(operations).toContain('## Releasing: CI and the tags')
    expect(readme).toContain('pnpm release:image plan <tag>')
  })
})
