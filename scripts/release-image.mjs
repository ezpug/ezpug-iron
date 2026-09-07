#!/usr/bin/env node
/**
 * **What an `<image>@<version>` tag publishes** (PRD-02 T34) — the one table
 * that says which image a release tag builds, from which Dockerfile, for which
 * platforms, under which registry tags. `.github/workflows/images.yml` reads it
 * in its first job and does nothing else with a tag name; a human reads it the
 * same way, before pushing one:
 *
 *   node scripts/release-image.mjs plan orchestrator@0.1.0  # what that tag would publish
 *   node scripts/release-image.mjs plan cs2                 # a dry run: build, never push
 *   node scripts/release-image.mjs images                   # the image names, one per line
 *
 * `plan` writes `key=value` lines — GitHub Actions' `$GITHUB_OUTPUT` format, so
 * the workflow's step is a redirect and no YAML parses a tag by hand.
 *
 * **The version lives in the tag.** Unlike `@ezpug/match-api`, an image has no
 * manifest in the tree that carries its number, so there is nothing a build
 * reads that a tag could disagree with — inventing a second home would only
 * create a drift to check for. What ties an image to this repo is its
 * `org.opencontainers.image.revision` label (the commit) and the build
 * provenance the workflow attests; `docs/pins.md` records which tag is live.
 */

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Where every image this repo publishes lives. One org, one repo, three names. */
export const REGISTRY = 'ghcr.io/ezpug/ezpug-iron'

/** The three images, their Dockerfile, and the platforms each is worth building. */
export const IMAGES = {
  orchestrator: {
    dockerfile: 'docker/orchestrator/Dockerfile',
    // Bundled JavaScript on the Node base image: an arm64 build is a second
    // native runner and nothing else. That is what "multi-arch where cheap"
    // buys — a mini PC at a venue running the service beside a node.
    platforms: ['linux/amd64', 'linux/arm64'],
  },
  node: {
    dockerfile: 'docker/node/Dockerfile',
    // Same recipe, same reason, and more of a reason: an agent's whole job is
    // to be the box that is already there.
    platforms: ['linux/amd64', 'linux/arm64'],
  },
  cs2: {
    dockerfile: 'docker/cs2/Dockerfile',
    // Valve ships the CS2 dedicated server for linux/amd64 only (and the
    // steamrt sniper base with it), so an arm64 tag would be an image with no
    // game in it — a worse answer than no tag at all.
    platforms: ['linux/amd64'],
  },
}

/**
 * GitHub's own runners, one per platform, so nothing is emulated: a qemu arm64
 * build turns a five-minute `pnpm install` into an hour and times the job out.
 * The `-arm` labels are free for public repositories, which this one is.
 */
const RUNNERS = {
  'linux/amd64': 'ubuntu-latest',
  'linux/arm64': 'ubuntu-24.04-arm',
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

class PlanError extends Error {}

const fail = message => {
  throw new PlanError(message)
}

const known = () => Object.keys(IMAGES).join(', ')

/**
 * The registry tags a version gets. A prerelease gets its exact version and
 * nothing else — `latest` and the `x.y` alias are promises about a release, and
 * a release candidate is not one.
 */
export function tagsFor(image, version) {
  const tags = [`${image}:${version}`]
  if (!version.includes('-')) {
    const [major, minor] = version.split('.')
    tags.push(`${image}:${major}.${minor}`, `${image}:latest`)
  }
  return tags
}

/**
 * Everything the workflow needs to know, from a tag name (`cs2@0.1.0`) or a
 * bare image name (a `workflow_dispatch` dry run: build it, push nothing).
 */
export function plan(reference) {
  if (!reference) fail(`usage: release-image.mjs plan <${known()}>[@<semver>]`)

  const at = reference.lastIndexOf('@')
  const name = at === -1 ? reference : reference.slice(0, at)
  const version = at === -1 ? '' : reference.slice(at + 1)

  const image = IMAGES[name]
  if (!image) fail(`no image is called "${name}" — this repo publishes ${known()}`)
  if (at !== -1 && !SEMVER.test(version)) {
    fail(`"${version}" is not a version: the tag is <image>@<major>.<minor>.<patch>`)
  }
  if (!existsSync(join(REPO, image.dockerfile))) {
    fail(`${image.dockerfile} does not exist — the table in this script is stale`)
  }

  const repository = `${REGISTRY}/${name}`
  return {
    name,
    image: repository,
    dockerfile: image.dockerfile,
    version,
    // A dry run builds every platform the real thing would, so it is the same
    // build; only the push is missing.
    builds: image.platforms.map(platform => ({
      platform,
      runner: RUNNERS[platform],
      // An artifact name may not contain a slash, and a digest has to come back
      // from each build under one.
      slug: platform.replace('/', '-'),
    })),
    push: version !== '',
    tags: version === '' ? [] : tagsFor(repository, version),
  }
}

const COMMANDS = {
  plan(argv) {
    const result = plan(argv[0])
    process.stdout.write(
      [
        `name=${result.name}`,
        `image=${result.image}`,
        `dockerfile=${result.dockerfile}`,
        `version=${result.version}`,
        `push=${result.push}`,
        `tags=${result.tags.join(',')}`,
        `builds=${JSON.stringify(result.builds)}`,
        '',
      ].join('\n'),
    )
  },
  images() {
    for (const name of Object.keys(IMAGES)) process.stdout.write(`${REGISTRY}/${name}\n`)
  },
}

// Importable (`scripts/check-pins.mjs` reads the table) and runnable; only the
// second one parses argv.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [verb, ...rest] = process.argv.slice(2)
  const command = COMMANDS[verb]
  if (!command) {
    process.stderr.write(`usage: release-image.mjs <${Object.keys(COMMANDS).join(' | ')}> [args]\n`)
    process.exit(2)
  }
  try {
    command(rest)
  } catch (error) {
    if (error instanceof PlanError) {
      process.stderr.write(`\nrelease-image: ${error.message}\n\n`)
      process.exit(1)
    }
    throw error
  }
}
