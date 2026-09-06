import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFakeClock } from '@ezpug/core'
import { beforeEach, describe, expect, it } from 'vitest'
import type { FakeDathost } from './fake'
import { createFakeDathost } from './fake'
import { DATHOST_DEFAULT_TAG, decodeTag } from './provider'

/**
 * **The template image script against the fake Dathost** (PRD-02 T18) — the
 * PRD's "`--dry-run` against T15 is the test", and everything either side of
 * it, because a script that builds the one server every rented match is cloned
 * from is not a thing to find out about on a Saturday.
 *
 * `scripts/dathost-image.mjs` is plain Node so an operator can run it out of a
 * clone without a build step; it exports `main({ fetch, env, … })` for exactly
 * this file, which hands it the in-process vendor instead of dathost.net and a
 * `sleep` that returns at once. Nothing here touches docker: the artifact tree
 * is written by hand below, in the shape `docker/cs2/Dockerfile` stages at
 * `/opt/ezpug` — five files instead of five hundred, mapped by the same rules.
 *
 * What the suite is really about:
 *
 * - **The clone gets our plugins.** The last thing a build does is
 *   `sync-files`, because `duplicate` copies the API's *cache*; the test
 *   duplicates the template afterwards and reads the plugin off the clone.
 * - **It refuses what is not the template.** A match's server, a clone, an
 *   unmarked server: each refused by name, each with `--adopt` as the
 *   deliberate way in.
 * - **A second run is free.** Idempotence is not a nicety here — 515 uploads
 *   per plugin bump would make refreshing the image something nobody does.
 */

const EMAIL = 'ops@ezpug.invalid'
const PASSWORD = 'not-a-real-dathost-password'
const BASE_URL = 'http://dathost.test/api/0.1'
const AUTHORIZATION = `Basic ${Buffer.from(`${EMAIL}:${PASSWORD}`).toString('base64')}`

const repo = join(dirname(fileURLToPath(import.meta.url)), '../../../../..')

/** The CounterStrikeSharp release the image pins — the tree has to say the same. */
const CSS_PIN = /^ARG COUNTER_STRIKE_SHARP_VERSION=(\S+)$/m.exec(
  readFileSync(join(repo, 'docker/cs2/Dockerfile'), 'utf8'),
)?.[1] as string

interface PlannedFile {
  source: string
  path: string
  size: number
  sha256: string
}

interface ImageScript {
  main(options: {
    argv?: string[]
    env?: Record<string, string | undefined>
    fetch?: typeof fetch
    sleep?: (ms: number) => Promise<void>
    now?: () => string
    stdout?: (text: string) => void
    stderr?: (text: string) => void
  }): Promise<number>
  TEMPLATE_TAG: string
  TEMPLATE_ROLE: string
  IMAGE_MANIFEST_PATH: string
  remotePathFor(relativePath: string): string | null
  planFiles(treeDir: string): PlannedFile[]
  templateUserData(): string
  readPins(dockerfile: string): Record<string, string | null>
}

const script = (await import(join(repo, 'scripts/dathost-image.mjs'))) as unknown as ImageScript

let fake: FakeDathost
let tree: string
let out: string[]
let err: string[]

/** The artifact tree, in the shape the CS2 image stages it. */
function writeTree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ezpug-image-'))
  const write = (path: string, content: string) => {
    mkdirSync(join(dir, dirname(path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  write(
    'addons/counterstrikesharp/plugins/EZPug.Core/build.json',
    `${JSON.stringify({ sdk: '0.1.0', core: '0.1.0', counterStrikeSharp: CSS_PIN, commit: 'f7f1232' })}\n`,
  )
  write('addons/counterstrikesharp/plugins/EZPug.Core/EZPug.Core.dll', 'the core plugin')
  write('addons/counterstrikesharp/plugins/disabled/MatchZy/MatchZy.dll', 'matchzy')
  write('addons/metamod/metaplugins.ini', ';\n')
  write('cfg/MatchZy/live.cfg', 'mp_maxrounds 24\n')
  // Copied by name into `cfg/` — what a manifest's `cfg: ["ezpug/pug.cfg"]` names.
  write('gamemodes/pug/cfg/ezpug/pug.cfg', 'mp_overtime_enable 1\n')
  // Data the assignment carries over the link; never a file on a server.
  write('gamemodes/pug/manifest.json', '{}\n')
  return dir
}

/** Run the script against the fake, with a `sleep` that costs nothing. */
async function run(argv: string[], env: Record<string, string | undefined> = {}): Promise<number> {
  out = []
  err = []
  return await script.main({
    argv,
    env: {
      EZPUG_IRON_DATHOST_EMAIL: EMAIL,
      EZPUG_IRON_DATHOST_PASSWORD: PASSWORD,
      EZPUG_IRON_DATHOST_API_URL: BASE_URL,
      ...env,
    },
    fetch: fake.fetch as unknown as typeof fetch,
    sleep: async () => {},
    now: () => '2026-09-06T12:00:00.000Z',
    stdout: text => out.push(text),
    stderr: text => err.push(text),
  })
}

/** The `--json` body of the last run. */
function summary(): Record<string, unknown> {
  return JSON.parse(out.join('')) as Record<string, unknown>
}

/** A built template, and its id. */
async function build(extra: string[] = []): Promise<string> {
  const code = await run(['--tree', tree, '--json', ...extra])
  expect(code, err.join('')).toBe(0)
  return String(summary().templateServerId)
}

async function vendor(
  method: string,
  path: string,
  form?: Record<string, string>,
): Promise<Response> {
  let body: FormData | undefined
  if (form) {
    body = new FormData()
    for (const [key, value] of Object.entries(form)) body.append(key, value)
  }
  return await fake.fetch(`${BASE_URL}${path}`, {
    method,
    headers: { authorization: AUTHORIZATION },
    ...(body && { body }),
  })
}

async function putFile(id: string, path: string, content: string): Promise<void> {
  const body = new FormData()
  body.append('file', new Blob([content]), 'file')
  await fake.fetch(`${BASE_URL}/game-servers/${id}/files/${path}`, {
    method: 'POST',
    headers: { authorization: AUTHORIZATION },
    body,
  })
}

beforeEach(() => {
  fake = createFakeDathost({ clock: createFakeClock(), email: EMAIL, password: PASSWORD })
  const previous = tree
  tree = writeTree()
  if (previous) rmSync(previous, { recursive: true, force: true })
})

describe('what an operator is told', () => {
  it('is the command docs/operations.md and package.json name', () => {
    const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(manifest.scripts['dathost:image']).toBe('node scripts/dathost-image.mjs')
    const operations = readFileSync(join(repo, 'docs/operations.md'), 'utf8')
    for (const command of [
      'pnpm dathost:image',
      'pnpm dathost:image --check',
      'pnpm dathost:image --dry-run',
    ])
      expect(operations).toContain(command)
    // The two files an operator meets before the script: the env var and the
    // script's own name.
    expect(readFileSync(join(repo, '.env.example'), 'utf8')).toContain('scripts/dathost-image.mjs')
    expect(operations).toContain('EZPUG_IRON_DATHOST_TEMPLATE_SERVER_ID')
  })

  it('answers --help without an account', async () => {
    expect(await run(['--help'], { EZPUG_IRON_DATHOST_EMAIL: undefined })).toBe(0)
    expect(out.join('')).toContain('--check')
    expect(out.join('')).toContain('--dry-run')
  })
})

describe('the artifact tree', () => {
  it('maps the image’s staging tree onto a Dathost server’s file root', () => {
    expect(script.remotePathFor('addons/metamod/metaplugins.ini')).toBe(
      'addons/metamod/metaplugins.ini',
    )
    expect(script.remotePathFor('cfg/MatchZy/live.cfg')).toBe('cfg/MatchZy/live.cfg')
    // The same `cp` `docker/cs2/entrypoint.sh` does on the volume.
    expect(script.remotePathFor('gamemodes/pug/cfg/ezpug/pug.cfg')).toBe('cfg/ezpug/pug.cfg')
    // The manifests are the assignment's, not the disk's (decision 5).
    expect(script.remotePathFor('gamemodes/pug/manifest.json')).toBeNull()
  })

  it('plans every file that belongs on a server, sorted and hashed', () => {
    const files = script.planFiles(tree)
    expect(files.map(file => file.path)).toEqual([
      'addons/counterstrikesharp/plugins/EZPug.Core/EZPug.Core.dll',
      'addons/counterstrikesharp/plugins/EZPug.Core/build.json',
      'addons/counterstrikesharp/plugins/disabled/MatchZy/MatchZy.dll',
      'addons/metamod/metaplugins.ini',
      'cfg/MatchZy/live.cfg',
      'cfg/ezpug/pug.cfg',
    ])
    expect(files.every(file => file.sha256.length === 64 && file.size > 0)).toBe(true)
  })

  it('reads the pins out of the Dockerfile, which is where they live', () => {
    const pins = script.readPins(readFileSync(join(repo, 'docker/cs2/Dockerfile'), 'utf8'))
    expect(pins.counterstrikesharp).toBe(CSS_PIN)
    expect(pins.metamod).toBeTruthy()
    expect(pins.matchzy).toBeTruthy()
  })

  it('wears the tag the orchestrator claims a server by', () => {
    // The provider's `list()` and the reaper read this; two constants, one
    // meaning, and a rename that touched only one of them would leak servers.
    expect(script.TEMPLATE_TAG).toBe(DATHOST_DEFAULT_TAG)
    expect(decodeTag(script.templateUserData())).toEqual({ tag: DATHOST_DEFAULT_TAG })
  })
})

describe('--dry-run', () => {
  it('says it would create a template, and creates nothing', async () => {
    const code = await run(['--tree', tree, '--dry-run', '--json'])
    expect(code).toBe(0)
    expect(summary()).toMatchObject({ ok: true, verb: 'dry-run', wouldCreate: true, uploads: 6 })
    expect(fake.servers()).toHaveLength(0)
  })

  it('names what it would upload to an existing template, and uploads nothing', async () => {
    const id = await build()
    await putFile(id, 'cfg/MatchZy/live.cfg', 'somebody edited this in the control panel')
    const before = fake.calls.length

    const code = await run(['--tree', tree, '--template', id, '--dry-run', '--json'])
    expect(code).toBe(0)
    expect(summary()).toMatchObject({ verb: 'dry-run', uploads: 1, unchanged: 5 })
    expect(fake.server(id)?.files.get('cfg/MatchZy/live.cfg')).toBe(
      'somebody edited this in the control panel',
    )
    // Reads only: a GET of the server, the manifest, the listing, gameinfo.
    expect(
      fake.calls.slice(before).every(call => call.startsWith('GET ')),
      fake.calls.slice(before).join('\n'),
    ).toBe(true)
  })
})

describe('building the template', () => {
  it('creates a protected, tagged, GOTV-on cs2 server and uploads the tree', async () => {
    const id = await build()
    const server = fake.server(id)

    expect(server?.raw.game).toBe('cs2')
    expect(server?.deletionProtection).toBe(true)
    expect(server?.raw.autostop).toBe(false)
    expect(server?.raw.reboot_on_crash).toBe(false)
    const cs2 = server?.raw.cs2_settings as Record<string, unknown>
    expect(cs2.enable_gotv).toBe(true)
    // Dathost's *managed* Metamod: ours is in the image, pinned and checksummed.
    expect(cs2.enable_metamod).toBe(false)
    expect(cs2.slots).toBe(12)
    // Never a token on the template: a clone would inherit it and evict the
    // server that already holds it (T17, one per running server).
    expect(cs2.steam_game_server_login_token ?? '').toBe('')

    expect(decodeTag(server?.userData)).toEqual({ tag: DATHOST_DEFAULT_TAG })
    expect([...(server?.files.keys() ?? [])].sort()).toEqual([
      'addons/counterstrikesharp/plugins/EZPug.Core/EZPug.Core.dll',
      'addons/counterstrikesharp/plugins/EZPug.Core/build.json',
      'addons/counterstrikesharp/plugins/disabled/MatchZy/MatchZy.dll',
      'addons/metamod/metaplugins.ini',
      'cfg/MatchZy/live.cfg',
      'cfg/ezpug/pug.cfg',
      script.IMAGE_MANIFEST_PATH,
    ])
    expect(summary()).toMatchObject({ ok: true, created: true, uploads: 6, synced: true })
  })

  it('prints the environment line an operator has to paste', async () => {
    await run(['--tree', tree])
    const id = fake.servers()[0]?.id
    expect(err.join('')).toContain(`EZPUG_IRON_DATHOST_TEMPLATE_SERVER_ID=${id}`)
  })

  it('records the pins and the revision, and no secret, in the manifest', async () => {
    const id = await build()
    const manifest = JSON.parse(fake.server(id)?.files.get(script.IMAGE_MANIFEST_PATH) as string)
    expect(manifest).toMatchObject({
      manifestVersion: 1,
      revision: 'f7f1232',
      pins: { counterstrikesharp: CSS_PIN },
      plugins: { sdk: '0.1.0', core: '0.1.0' },
    })
    expect(Object.keys(manifest.files)).toHaveLength(6)
    const text = JSON.stringify(manifest)
    expect(text).not.toContain(PASSWORD)
    expect(text).not.toContain('fake-rcon')
  })

  it('syncs last, so the clone every match runs carries the plugin', async () => {
    // Without `sync-files` a `duplicate` copies the API's stale cache — the
    // trap `references/dathost.md` warns about, and the reason this ordering
    // is a test and not a comment.
    const id = await build()
    const clone = (await (await vendor('POST', `/game-servers/${id}/duplicate`)).json()) as {
      id: string
    }
    expect(fake.server(clone.id)?.files.get('addons/metamod/metaplugins.ini')).toBe(';\n')
    expect(
      fake
        .server(clone.id)
        ?.files.get('addons/counterstrikesharp/plugins/EZPug.Core/EZPug.Core.dll'),
    ).toBe('the core plugin')
  })

  it('is idempotent: a second run uploads nothing and syncs nothing', async () => {
    const id = await build()
    const before = fake.calls.length

    const code = await run(['--tree', tree, '--template', id, '--json'])
    expect(code).toBe(0)
    expect(summary()).toMatchObject({ uploads: 0, unchanged: 6 })
    const writes = fake.calls.slice(before).filter(call => !call.startsWith('GET '))
    // Only the manifest and the sync it makes true.
    expect(writes).toEqual([
      `POST /api/0.1/game-servers/${id}/files/${script.IMAGE_MANIFEST_PATH}`,
      `POST /api/0.1/game-servers/${id}/sync-files`,
    ])
  })

  it('re-uploads everything when it is told to stop being clever', async () => {
    const id = await build()
    expect(await run(['--tree', tree, '--template', id, '--force', '--json'])).toBe(0)
    // The one case a hash and a listing cannot see is an edit that kept the
    // byte count; --force is the answer, and it is the only answer.
    expect(summary()).toMatchObject({ uploads: 6, unchanged: 0 })
  })

  it('re-uploads only what changed, including a file edited behind its back', async () => {
    const id = await build()
    await putFile(id, 'cfg/ezpug/pug.cfg', 'somebody edited this in the control panel')
    const before = fake.calls.length

    await run(['--tree', tree, '--template', id, '--json'])
    expect(summary()).toMatchObject({ uploads: 1, unchanged: 5 })
    expect(fake.server(id)?.files.get('cfg/ezpug/pug.cfg')).toBe('mp_overtime_enable 1\n')
    expect(fake.calls.slice(before)).toContain(
      `POST /api/0.1/game-servers/${id}/files/cfg/ezpug/pug.cfg`,
    )
  })

  it('adds Metamod’s loader line to gameinfo.gi, once', async () => {
    const id = await build()
    await putFile(
      id,
      'gameinfo.gi',
      'GameInfo\n{\n\tFileSystem\n\t{\n\t\tGame_LowViolence\tcsgo_lv\n\t}\n}\n',
    )

    await run(['--tree', tree, '--template', id, '--json'])
    const patched = fake.server(id)?.files.get('gameinfo.gi') as string
    expect(patched.split('\n')).toContain('\t\t\tGame\tcsgo/addons/metamod')
    // Anchored where `docker/cs2/entrypoint.sh` anchors it: right after the
    // low-violence search path, inside the FileSystem block.
    expect(patched.indexOf('Game_LowViolence')).toBeLessThan(patched.indexOf('addons/metamod'))

    await run(['--tree', tree, '--template', id, '--json'])
    expect(summary().gameinfoPatched).toBeUndefined()
    expect(patched.match(/addons\/metamod/g)).toHaveLength(1)
  })

  it('backs off a 429 and finishes the upload', async () => {
    fake.setFaults({ status: { code: 429, times: 3 } })
    const id = await build()
    expect(fake.server(id)?.files.size).toBe(7)
  })
})

describe('what it refuses', () => {
  it('refuses without an account, and never asks for one on a flag', async () => {
    const code = await run(['--tree', tree, '--json'], {
      EZPUG_IRON_DATHOST_EMAIL: undefined,
      EZPUG_IRON_DATHOST_PASSWORD: undefined,
    })
    expect(code).toBe(1)
    expect(JSON.stringify(summary().problems)).toContain('EZPUG_IRON_DATHOST_PASSWORD')
    expect(script.main.toString()).not.toContain("flags.get('password')")
  })

  it('refuses a server that carries a match’s tag', async () => {
    const id = await build()
    const other = (await (
      await vendor('POST', '/game-servers', {
        game: 'cs2',
        name: 'ezpug 1234 cs2',
        user_data: JSON.stringify({ tag: DATHOST_DEFAULT_TAG, matchId: 'm-1' }),
      })
    ).json()) as { id: string }

    const code = await run(['--tree', tree, '--template', other.id, '--json'])
    expect(code).toBe(1)
    expect(JSON.stringify(summary().problems)).toContain("is a match's server")
    // --adopt is for an unmarked server, never for one somebody is playing on.
    expect(await run(['--tree', tree, '--template', other.id, '--adopt', '--json'])).toBe(1)
    // The template it should have been pointed at is untouched.
    expect(fake.server(id)?.files.size).toBe(7)
    expect(fake.server(other.id)?.files.size).toBe(0)
  })

  it('refuses a clone of the template', async () => {
    const id = await build()
    const clone = (await (await vendor('POST', `/game-servers/${id}/duplicate`)).json()) as {
      id: string
    }
    // A clone's `user_data` is the template's until the provider's PUT lands,
    // so the vendor's own `duplicate_source_server` is what gives it away.
    await vendor('PUT', `/game-servers/${clone.id}`, { user_data: '' })

    const code = await run(['--tree', tree, '--template', clone.id, '--json'])
    expect(code).toBe(1)
    expect(JSON.stringify(summary().problems)).toContain('is a clone of')
    expect(await run(['--tree', tree, '--template', clone.id, '--adopt', '--json'])).toBe(1)
  })

  it('refuses an unmarked server, and takes --adopt as the deliberate way in', async () => {
    const stranger = (await (
      await vendor('POST', '/game-servers', {
        game: 'cs2',
        name: "somebody else's server",
      })
    ).json()) as { id: string }

    expect(await run(['--tree', tree, '--template', stranger.id, '--json'])).toBe(1)
    expect(JSON.stringify(summary().problems)).toContain('--adopt')
    expect(fake.server(stranger.id)?.files.size).toBe(0)

    expect(await run(['--tree', tree, '--template', stranger.id, '--adopt', '--json'])).toBe(0)
    expect(decodeTag(fake.server(stranger.id)?.userData)).toEqual({ tag: DATHOST_DEFAULT_TAG })
  })

  it('refuses a template that is running, unless forced', async () => {
    const id = await build()
    await vendor('POST', `/game-servers/${id}/start`)

    expect(await run(['--tree', tree, '--template', id, '--json'])).toBe(1)
    expect(JSON.stringify(summary().problems)).toContain('is running')

    await putFile(id, 'cfg/ezpug/pug.cfg', 'edited')
    expect(await run(['--tree', tree, '--template', id, '--force', '--json'])).toBe(0)
    expect(fake.server(id)?.files.get('cfg/ezpug/pug.cfg')).toBe('mp_overtime_enable 1\n')
  })

  it('refuses an id that is not on the account', async () => {
    expect(await run(['--tree', tree, '--template', 'ffffffffffffffffffffffff', '--json'])).toBe(1)
    expect(JSON.stringify(summary().problems)).toContain('no server')
  })

  it('refuses a tree whose plugins were built against another CounterStrikeSharp', async () => {
    writeFileSync(
      join(tree, 'addons/counterstrikesharp/plugins/EZPug.Core/build.json'),
      `${JSON.stringify({ sdk: '0.1.0', core: '0.1.0', counterStrikeSharp: '1.0.1', commit: 'old' })}\n`,
    )
    expect(await run(['--tree', tree, '--json'])).toBe(1)
    expect(JSON.stringify(summary().problems)).toContain('pnpm cs2:build')
    expect(fake.servers()).toHaveLength(0)
  })
})

describe('--check', () => {
  it('is green on a template this tree built', async () => {
    const id = await build()
    expect(await run(['--tree', tree, '--template', id, '--check', '--json'])).toBe(0)
    expect(summary()).toMatchObject({ ok: true, verb: 'check', problems: [] })
  })

  it('is red on a file that is not this tree’s', async () => {
    const id = await build()
    await putFile(id, 'addons/metamod/metaplugins.ini', '; edited on the box\n')
    expect(await run(['--tree', tree, '--template', id, '--check', '--json'])).toBe(1)
    expect(JSON.stringify(summary().problems)).toContain('addons/metamod/metaplugins.ini')
  })

  it('is red when the template carries another pin than docs/pins.md’s home', async () => {
    const id = await build()
    const manifest = JSON.parse(fake.server(id)?.files.get(script.IMAGE_MANIFEST_PATH) as string)
    manifest.pins.matchzy = '0.8.14'
    await putFile(id, script.IMAGE_MANIFEST_PATH, JSON.stringify(manifest))

    expect(await run(['--tree', tree, '--template', id, '--check', '--json'])).toBe(1)
    expect(JSON.stringify(summary().problems)).toContain('matchzy 0.8.14')
  })

  it('is red when a setting drifted, and says which', async () => {
    const id = await build()
    await vendor('PUT', `/game-servers/${id}`, {
      deletion_protection: 'false',
      'cs2_settings.enable_gotv': 'false',
      'cs2_settings.steam_game_server_login_token': 'a-token-that-should-not-be-here',
    })

    expect(await run(['--tree', tree, '--template', id, '--check', '--json'])).toBe(1)
    const problems = JSON.stringify(summary().problems)
    expect(problems).toContain('deletion_protection is off')
    expect(problems).toContain('GOTV is off')
    expect(problems).toContain('GSLT')
    // The token itself is never echoed back.
    expect(problems).not.toContain('a-token-that-should-not-be-here')
  })

  it('is red when Metamod’s loader line is gone from gameinfo.gi', async () => {
    const id = await build()
    await putFile(id, 'gameinfo.gi', 'GameInfo\n{\n\tGame_LowViolence\tcsgo_lv\n}\n')
    expect(await run(['--tree', tree, '--template', id, '--check', '--json'])).toBe(1)
    expect(JSON.stringify(summary().problems)).toContain('no Metamod loader line')
  })

  it('has nothing to check without a template id', async () => {
    expect(await run(['--tree', tree, '--check', '--json'])).toBe(1)
    expect(JSON.stringify(summary().problems)).toContain('nothing to check')
  })

  it('puts the drift right when it is asked to build', async () => {
    const id = await build()
    await vendor('PUT', `/game-servers/${id}`, {
      deletion_protection: 'false',
      'cs2_settings.steam_game_server_login_token': 'a-token-that-should-not-be-here',
    })

    expect(await run(['--tree', tree, '--template', id, '--json'])).toBe(0)
    expect(await run(['--tree', tree, '--template', id, '--check', '--json'])).toBe(0)
    const cs2 = fake.server(id)?.raw.cs2_settings as Record<string, unknown>
    expect(cs2.steam_game_server_login_token).toBe('')
  })
})
