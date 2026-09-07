import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * **The CS2 server image, held against the files that describe it** (PRD-02
 * T10). The image is the whole server: Metamod, CounterStrikeSharp, the
 * vendored plugins, `EZPug.Core` and the gamemodes' cfg set, run by
 * `docker/cs2/entrypoint.sh` from a game install that lives in a volume. Three
 * separate places have to agree about it — the Dockerfile, `compose.cs2.yaml`
 * and `.env.example` — and a fourth (`docs/operations.md`) is what an operator
 * reads instead of any of them.
 *
 * It reads files rather than running docker, exactly like the orchestrator
 * image's test beside it (`image.test.ts`), which is why it lives here: this
 * package is the repo's Vitest home for holding an image against its
 * documentation. Building it is `pnpm cs2:build`; running it is `pnpm cs2:up`
 * and the `EZPUG_CS2_TESTS` lane (T13).
 */

const repoUrl = (path: string): string =>
  fileURLToPath(new URL(`../../../${path}`, import.meta.url))
const repo = (path: string): string => readFileSync(repoUrl(path), 'utf8')

const dockerfile = repo('docker/cs2/Dockerfile')
const entrypoint = repo('docker/cs2/entrypoint.sh')
const install = repo('docker/cs2/install-game.sh')
const compose = repo('compose.cs2.yaml')
const envExample = repo('.env.example')
const operations = repo('docs/operations.md')
const manifest = JSON.parse(repo('package.json')) as { scripts: Record<string, string> }

describe('the CS2 server image', () => {
  it('is pinned everywhere it reaches the network', () => {
    // The base by digest, not by the tag it also carries: the tag moves.
    expect(dockerfile).toMatch(
      /^FROM registry\.gitlab\.steamos\.cloud\/steamrt\/sniper\/platform:\S+@sha256:[0-9a-f]{64} AS cs2$/m,
    )
    // The compiler is exactly the one `plugins/global.json` pins, so the image
    // is built by the toolchain the tests ran on.
    const dotnet = (JSON.parse(repo('plugins/global.json')) as { sdk: { version: string } }).sdk
      .version
    expect(dockerfile).toContain(`FROM mcr.microsoft.com/dotnet/sdk:${dotnet} AS plugins`)
    // Every downloaded artifact is a version *and* a checksum. `check-pins`
    // holds the versions against docs/pins.md; this holds the shape.
    for (const artifact of ['METAMOD', 'COUNTER_STRIKE_SHARP', 'MATCHZY']) {
      expect(dockerfile).toMatch(new RegExp(`^ARG ${artifact}_VERSION=\\S+$`, 'm'))
      expect(dockerfile).toMatch(new RegExp(`^ARG ${artifact}_SHA256=[0-9a-f]{64}$`, 'm'))
    }
    expect(dockerfile).toContain('sha256sum -c -')
  })

  it('builds the plugin tree with the same script a hand install uses', () => {
    expect(dockerfile).toContain('./publish.sh /out')
    // `plugins/publish.sh` records the commit in build.json and there is no
    // checkout inside the build, so the sha has to arrive as a build argument.
    expect(dockerfile).toMatch(/^ARG EZPUG_GIT_SHA=unknown$/m)
    expect(repo('plugins/publish.sh')).toContain('${EZPUG_GIT_SHA:-')
    // MatchZy lands under `disabled/` by the folder name the manifest says,
    // because that is what the core plugin's loader hot-loads (decision 16).
    expect(dockerfile).toContain('/out/addons/counterstrikesharp/plugins/disabled/MatchZy')
    const pug = JSON.parse(repo('gamemodes/pug/manifest.json')) as { plugins: string[] }
    expect(pug.plugins).toContain('MatchZy')
  })

  it('ships the WeaponPaints fork from the vendored source, with no database anywhere', () => {
    // PRD-02 T28, decision 20: the one patched vendor. Its loadouts come from the
    // core plugin over the link, so nothing MySQL-shaped may be left in its tree,
    // and the image lays it out like every other hot-loaded plugin folder.
    const build = repo('plugins/vendor/build.sh')
    expect(dockerfile).toContain('./vendor/build.sh /vendor-out')
    expect(build).toContain('dotnet build WeaponPaints/WeaponPaints.csproj')
    expect(build).toContain('$css/plugins/disabled/WeaponPaints')
    expect(build).toContain('cp WeaponPaints/gamedata/weaponpaints.json "$css/gamedata/"')
    // Newtonsoft.Json rides beside it (the runtime does not ship it); EZPug.Sdk never does.
    expect(build).toContain('Newtonsoft.Json.dll')
    expect(build).toContain('test ! -e "$wp_out/EZPug.Sdk.dll"')
    const vendored = JSON.parse(repo('plugins/vendor/vendored.json')) as {
      plugins: { directory: string; patches?: string }[]
    }
    const fork = vendored.plugins.find(plugin => plugin.directory === 'WeaponPaints')
    expect(fork?.patches).toBe('WeaponPaints/PATCHES.md')
    expect(existsSync(repoUrl(`plugins/vendor/${fork?.patches}`))).toBe(true)
    const forkDirectory = repoUrl('plugins/vendor/WeaponPaints')
    for (const file of readdirSync(forkDirectory, { recursive: true, withFileTypes: true })) {
      if (!file.isFile() || !/\.(cs|csproj)$/.test(file.name)) continue
      // Code only: PATCHES.md's story is retold in a comment or two, and a comment
      // naming what was removed is not what was removed.
      const code = readFileSync(`${file.parentPath}/${file.name}`, 'utf8')
        .replace(/<!--[\s\S]*?-->/g, '')
        .split('\n')
        .filter(line => !/^\s*(\/\/|\*)/.test(line))
        .join('\n')
      expect(code, `${file.name} still speaks MySQL`).not.toMatch(/MySql|Dapper|MenuManager/)
    }
    // The orchestrator only turns the folder on when a loadout is on the roster.
    expect(repo('apps/orchestrator/src/link/assign.ts')).toContain("SKINS_PLUGIN = 'WeaponPaints'")
  })

  it('never runs as root and opens only the game and GOTV ports', () => {
    expect(dockerfile).toMatch(/^USER steam$/m)
    expect(dockerfile).toMatch(/^HEALTHCHECK /m)
    expect(dockerfile).toMatch(/^ENTRYPOINT \["\/usr\/local\/bin\/entrypoint\.sh"\]$/m)
    // The two ports .env.example decides, and nothing else — a server's only
    // relationship with the world besides these is its outbound link.
    const game = envExample.match(/^EZPUG_IRON_CS2_GAME_PORT=(\d+)$/m)?.[1]
    const gotv = envExample.match(/^EZPUG_IRON_CS2_GOTV_PORT=(\d+)$/m)?.[1]
    expect(game).toBe('27415')
    expect(gotv).toBe('27420')
    expect(dockerfile).toContain(`EXPOSE ${game}/udp ${game}/tcp ${gotv}/udp`)
  })

  it('refuses to boot without a game install rather than downloading one', () => {
    expect(entrypoint).toContain('pnpm cs2:install')
    expect(entrypoint).toMatch(/if \[\[ ! -x "\$BINARY" \]\]; then\n\s*die /)
    // The download is its own entrypoint, run by hand, and it says how big it
    // is before it starts.
    expect(install).toContain('APP_ID=730')
    expect(install).toContain('+app_update "$APP_ID"')
    // The size an operator is warned about is the size this box measured when
    // T10 ran it, not a guess: 67 GB installed from a 71 GB download.
    expect(install).toMatch(/67 GB installed \(~71 GB downloaded\)/)
    expect(dockerfile).not.toContain('app_update')
  })

  it('starts the server the way the round decided to', () => {
    for (const flag of ['-dedicated', '-usercon', '+tv_port', '+sv_hibernate_when_empty 0', '+map'])
      expect(entrypoint).toContain(flag)
    // `exec`, so the game is PID 1: signals reach it and `docker attach` is a
    // real server console (`pnpm cs2:console`).
    expect(entrypoint).toMatch(/^exec "\$BINARY" \\$/m)
    // No GSLT: the pool is leased for Dathost only (T17), and without one CS2
    // takes LAN connections, which is all a node ever needs.
    expect(entrypoint).not.toContain('sv_setsteamaccount')
  })

  it('prints where home is and never a secret', () => {
    expect(entrypoint).toContain('EZPUG_IRON_URL')
    expect(entrypoint).toContain('EZPUG_SERVER_TOKEN')
    expect(entrypoint).toContain('ezpug.json')
    expect(entrypoint).toContain('unlinked')
    // The two secrets that pass through this file are used and never echoed:
    // no `log`/`echo`/`printf` line may interpolate either of them.
    for (const secret of ['EZPUG_SERVER_TOKEN', 'rcon_password'])
      for (const line of entrypoint.split('\n'))
        if (/^\s*(log|echo)\b/.test(line)) expect(line).not.toContain(`$${secret}`)
    expect(entrypoint).toContain('not logged')
    // The RCON password never goes on the command line. CounterStrikeSharp
    // echoes the raw command line at boot, so `+rcon_password` there would sit
    // in `docker logs` in clear — it is exec'd from a 0600 cfg instead.
    // The comments explain why, so only what the shell actually runs counts.
    const code = entrypoint
      .split('\n')
      .filter(line => !/^\s*#/.test(line))
      .join('\n')
    expect(code).not.toContain('+rcon_password')
    expect(code).toContain('+exec ezpug/rcon')
    expect(code).toContain('install -m 600')
  })

  it('installs the addons and the cfg set from the image on every boot', () => {
    // Decision 16: the image is the truth, so nothing on the volume outlives a
    // restart unnoticed.
    expect(entrypoint).toContain('rm -rf "$CSGO/addons/metamod" "$CSGO/addons/counterstrikesharp"')
    expect(entrypoint).toContain('cp -a "$IMAGE_DIR/addons/." "$CSGO/addons/"')
    // Metamod loads because gameinfo.gi says so, and a game update rewrites it.
    expect(entrypoint).toContain('gameinfo.gi')
    expect(entrypoint).toContain('Game_LowViolence')
    // `gamemodes/<id>/cfg` by name, which is what a manifest's `cfg` is
    // relative to. Every cfg file a shipped manifest names has to be there.
    expect(entrypoint).toContain('"$gamemodes_dir"/*/manifest.json')
    for (const mode of readdirSync(repoUrl('gamemodes'), { withFileTypes: true })) {
      if (!mode.isDirectory()) continue
      const cfgDirectory = repoUrl(`gamemodes/${mode.name}/cfg`)
      if (!existsSync(cfgDirectory)) continue
      const declared = (
        JSON.parse(repo(`gamemodes/${mode.name}/manifest.json`)) as {
          cfg?: string[]
        }
      ).cfg
      for (const file of declared ?? [])
        expect(
          existsSync(repoUrl(`gamemodes/${mode.name}/cfg/${file}`)),
          `gamemodes/${mode.name}/manifest.json names cfg/${file}, which the image would not carry`,
        ).toBe(true)
    }
  })

  it('unlocks the scoreboard rating and says why it may', () => {
    // PRD-02 T27: CounterStrikeSharp refuses `m_iCompetitiveRanking` and
    // `m_iCompetitiveRankType` while `FollowCS2ServerGuidelines` is on, and
    // EZ Rating is those two fields (decision 21). Written from the pinned
    // release's own example so no other key is ours to keep up to date, and
    // asserted right there so an upstream rename fails the build.
    expect(dockerfile).toContain('"FollowCS2ServerGuidelines": false')
    expect(dockerfile).toContain('configs/core.example.json')
    expect(dockerfile).toContain('configs/core.json')
    expect(dockerfile).toMatch(/grep -q '"FollowCS2ServerGuidelines": false'/)
    // The risk it buys is a GSLT the guidelines could withhold, and that is an
    // operator's business, not a build's.
    expect(repo('docs/operations.md')).toContain('FollowCS2ServerGuidelines: false')
  })

  it('is run by a compose file and the scripts the docs name', () => {
    expect(compose).toContain('dockerfile: docker/cs2/Dockerfile')
    expect(compose).toContain('network_mode: host')
    expect(compose).toContain('cs2-data:/serverdata/serverfiles')
    expect(compose).toContain('./gamemodes:/opt/ezpug/gamemodes:ro')
    // Every variable the compose file reads is documented in .env.example.
    for (const variable of compose.match(/\$\{(EZPUG_[A-Z0-9_]+)/g) ?? []) {
      const name = variable.slice(2)
      if (name === 'EZPUG_GIT_SHA') continue
      expect(envExample, `${name} is read by compose.cs2.yaml but not in .env.example`).toContain(
        name,
      )
    }
    for (const verb of ['build', 'install', 'up', 'down', 'status', 'logs', 'console'])
      expect(manifest.scripts[`cs2:${verb}`]).toBe(`./scripts/cs2-env.sh ${verb}`)
  })

  it('is documented by the commands an operator types', () => {
    expect(operations).toContain('ghcr.io/ezpug/ezpug-iron/cs2')
    for (const command of ['pnpm cs2:build', 'pnpm cs2:install', 'pnpm cs2:up', 'pnpm cs2:console'])
      expect(operations).toContain(command)
  })
})
