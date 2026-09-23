#!/usr/bin/env node
// One real match, end to end, through the Match API — and everything it said,
// written down (PRD-02 T13).
//
//   pnpm iron:match                       a pug on the dev node, bots, four rounds
//   pnpm iron:match --write-fixtures      …and update the recorded fixtures
//   pnpm iron:match --gamemode flying-scoutsman --no-demo
//   node scripts/iron-match.mjs --help
//
// The point is not that a match runs: the point is that plugin, MatchZy,
// orchestrator and contract are recorded agreeing. The script is a client and
// nothing more — it holds an API key, POSTs a match, listens on a webhook
// endpoint of its own and on the match's stream, and reads the events route.
// The two conversations a client cannot see (the `/link` and `/node` frames,
// the payloads MatchZy POSTs) come from the orchestrator's own trace file,
// which is why it has to have been started with `EZPUG_IRON_TRACE_FILE` set;
// without one the run still happens and says what it could not record.
//
// Nothing it writes holds a secret: the trace is scrubbed as it is written
// (`apps/orchestrator/src/trace.ts`) and everything here goes through
// `scrub()` again, which also rebases every timestamp and every identity onto
// the fixtures' own so a second run produces the same bytes.
import { spawnSync } from 'node:child_process'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describeLaneLock, describeLaneQueue, takeLaneLock } from './cs2-lane-lock.mjs'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(repo, 'apps/orchestrator/package.json'))
/** `ws`, because Node's own WebSocket cannot send an Authorization header. */
const WebSocket = require('ws')
/**
 * The published package, from its build — the same bytes a client installs.
 * Loaded lazily because `--rebuild` needs nothing from it and a fresh clone's
 * `dist/` does not exist until `pnpm build` has run.
 */
async function matchApi() {
  const dist = join(repo, 'packages/match-api/dist/index.js')
  try {
    return await import(pathToFileURL(dist).href)
  } catch {
    return die(`no build at ${dist} — run \`pnpm build\` first`)
  }
}

// ---------------------------------------------------------------------------
// Arguments and environment
// ---------------------------------------------------------------------------

const HELP = `iron-match — run one real match through the Match API and record it (PRD-02 T13)

  --gamemode <id>        default pug
  --map <name>           default de_dust2
  --rounds <n>           mp_maxrounds; even, default 4
  --bots <n>             how many bodies; default 10. Anonymous bots without
                         --simulate, puppets with it. 0 leaves the server empty
  --simulate             play it with puppets (PRD-03 T5): --bots bodies are
                         rostered, split a side, and MatchZy-Enhanced's
                         simulation mode gives each rostered SteamID a bot that
                         readies up through the ready system a human types into
  --timescale <n>        simulation.timeScale — the engine clock the puppets
                         play at, 0.1 to 10; only with --simulate
  --scenario <name>      simulation.scenario (PRD-03 T11) — what the puppets do
                         beyond playing the match out, from the catalog
                         GET /v1/sim/scenarios lists and the simulator plays.
                         no-show leaves roster entries without a body, idle
                         seats nobody at all; a scenario a real server cannot
                         execute is refused at the door. Only with --simulate
  --force-start          the escape hatch (PRD-03, Attitude 2): empty the
                         server, css_start over RCON and end the warmup by
                         hand, because an unrostered bot never readies up. An
                         assertion skipped — no green run may depend on it
  --format <name>        rules.format: competitive (default) or wingman, the
                         two-a-side game — use it with --bots 4
  --sides <ct|t|knife>   maps[0].sides; default ct. \`knife\` knifes for the
                         side, and a room of puppets never types .stay — so
                         the side-selection timer T3a turned on is what
                         decides it (PRD-03 T6)
  --humans <n>           a mixed roster (PRD-04 T2): the last n rostered
                         entries are people, not puppets — simulation.puppets
                         names the rest — so their chairs stay empty and the
                         run proves nothing sits down in them. Needs
                         --simulate, fewer than --bots, and a mode whose
                         manifest claims capabilities.mixedRoster
  --stand-in             once the match is live, bot_add one plain bot per
                         --humans over RCON, standing in for a person who
                         never came: the assertion is that it is furniture —
                         never announced, never cast as the person. The one
                         RCON command of the row, declared as such. SDK flows
                         only: MatchZy's gate never counts a plain bot
  --hold                 matchzy + --humans: wait for every puppet's
                         player_ready, hold the warmup for the person past
                         the fork's watchdog, and then call the match off the
                         way a client does for a no-show (cancel). The run
                         ends cancelled, and that is its success (T2b)
  --pause                pause the live match through the Match API and
                         unpause it two polls later (PRD-03 T6)
  --restore              the moment round 3 ends, restore the live match
                         to round 2 through the Match API and lift the pause
                         MatchZy puts on a restored round (PRD-04 T8)
  --drop-puppet          take one puppet off the server while it is still in
                         warmup and let it come back, which is the only thing
                         that ever holds a loaded match at the gate. The kick
                         is the Match API's own, addressed to the SteamID the
                         request rostered — the only id a client ever holds —
                         and nothing is typed at the server (PRD-03 T7a)
  --widget               drive the mode's widget socket as a puppet's phone
                         (PRD-03 T8): mint a player token for the first
                         rostered SteamID, say hello on GET /v1/widget, claim
                         a power-up, tap again on every death of that puppet
                         to meet \`not_alive\`, and tap once as a stranger the
                         request never rostered. Needs --simulate and a mode
                         whose manifest declares a widget and a verb
  --walk <seconds>       the movement spike (PRD-03 T12): once the match is
                         live, watch the engine move the puppets, then have the
                         server walk every one of them around a circle by
                         teleporting it once per engine frame, and measure both
                         windows off the stream's position ticks — what a
                         radar would draw. Sends one RCON command
                         (\`ezpug_walk\`), which is the only door there is for
                         it. Needs --simulate
  --ready-gate <n>       rules.warmup.minPlayersToReady across both teams;
                         default 0, which is "everybody connected must ready".
                         The builder halves it per team, and MatchZy-Enhanced
                         then passes a side at that many ready — so --bots 10
                         --ready-gate 8 is a five whose gate is four (PRD-03
                         T5a)
  --no-overtime          allow a drawn map — MatchZy then replays it, so the run hangs
  --max-live-minutes <n> force-end a match still live after this long; default 35
  --base-url <url>       default $EZPUG_IRON_BASE_URL
  --admin-key <secret>   an existing admin key, instead of minting one from the
                         box's own database; default $EZPUG_IRON_ADMIN_KEY. The
                         only way to record against a deployment this checkout
                         has no database handle on (production, PRD-02 T36).
  --provider <id>        requirements.provider — this provider and no other
  --lan <true|false>     requirements.lan; default true (the dev node)
  --budget-cents <n>     the monthly ceiling of the run's own key; default 0,
                         which is a ceiling of zero — free providers only. A
                         run that rents a box needs a real number.
  --webhook-host <addr>  where the run's webhook endpoint binds and how the
                         orchestrator is told to reach it; default 127.0.0.1.
                         A containerised orchestrator reaches this box at the
                         docker bridge gateway, 172.17.0.1.
  --demo-relay <host>    presign the demo PUT against http://<host>:<port> and
                         relay that port to the S3 endpoint below. A rented box
                         in a datacentre cannot reach a loopback MinIO; this is
                         the door it can (PRD-02 T36).
  --trace <file>         the orchestrator's trace; default $EZPUG_IRON_TRACE_FILE
  --no-trace             record no trace at all — what a run against a
                         deployment that writes none has to say, rather than
                         reading this box's dev trace because .env named one
  --out <dir>            where the run is written; default .cache/iron-match/<run>
  --no-demo              do not mint a demo upload URL
  --write-fixtures       update the recorded fixtures from this run
  --fixture-prefix <id>  what the written fixtures are called; default 'real',
                         so real-<gamemode>-bo1.json and its exchanges
  --rebuild <dir>        write the files again from a finished run's raw.json,
                         without playing another match
  --timeout-minutes <n>  give up and cancel after this long; default 45
  --lock-wait <minutes>  how long to wait for the shared CS2 lane lock before
                         giving up; default 45. A run that may land on this
                         box's one CS2 container takes that lock first, because
                         the platform's own lane plays matches on it too
                         (docs/operations.md, "The lane lock")
  --no-lock              take no lane lock — a run on a container nobody else
                         shares, or an operator who has just broken a stale one
  --json                 print the run summary as JSON and nothing else
  --help
`

function args(argv) {
  const flags = new Map()
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const [name, inline] = token.slice(2).split('=', 2)
    if (inline !== undefined) flags.set(name, inline)
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags.set(name, argv[++i])
    else flags.set(name, 'true')
  }
  return flags
}

const flags = args(process.argv.slice(2))
if (flags.has('help')) {
  process.stdout.write(HELP)
  process.exit(0)
}

try {
  process.loadEnvFile(join(repo, '.env'))
} catch {
  // A fresh clone has no .env; the process environment is all there is.
}

const QUIET = flags.get('json') === 'true'
const say = line => {
  if (!QUIET) process.stderr.write(`\x1b[36m[iron-match]\x1b[0m ${line}\n`)
}
const die = line => {
  process.stderr.write(`\x1b[31m[iron-match] error:\x1b[0m ${line}\n`)
  process.exit(1)
}

const BASE_URL = (
  flags.get('base-url') ??
  process.env.EZPUG_IRON_BASE_URL ??
  process.env.EZPUG_IRON_PUBLIC_URL ??
  'http://127.0.0.1:3430'
).replace(/\/+$/, '')
/**
 * An `admin` key that already exists, instead of minting one.
 *
 * The mint below runs `keys:mint` in `apps/orchestrator`, which opens the
 * database this checkout is configured for — the dev one. Production's
 * database is inside `compose.prod.yaml` and published to nothing, which is
 * the point (T35), so a recording against `gs.ezpug.com` has to be handed the
 * operator's key instead (`EZPUG_IRON_API_KEY` in `.env.production`).
 */
const ADMIN_KEY = flags.get('admin-key') ?? process.env.EZPUG_IRON_ADMIN_KEY ?? null
/** `requirements.provider` — this provider and no other. */
const PROVIDER = flags.get('provider') ?? null
/**
 * The monthly ceiling of the key this run mints for itself, in cents. Zero —
 * the default — is a ceiling of *zero* (T37d): a match on a free provider
 * runs, a match that would rent a box is refused `402 budget_exceeded`. A run
 * that means to rent one says how much it may cost.
 */
const BUDGET_CENTS = Number(flags.get('budget-cents') ?? 0)
/** `requirements.lan`. True is the dev node; false is whatever the deployment rents. */
const LAN = (flags.get('lan') ?? 'true') !== 'false'
/**
 * Where the run's webhook endpoint binds, and the address the orchestrator is
 * given for it. The default is loopback because the dev orchestrator is a
 * process on this box; a containerised one reaches the host at the docker
 * bridge gateway, and nothing on the internet reaches either.
 */
const WEBHOOK_HOST = flags.get('webhook-host') ?? '127.0.0.1'
/**
 * The public name of the demo relay, or null for no relay.
 *
 * The demo PUT is made by the **plugin on the game server** — so on a rented
 * box in a datacentre, over the internet. The platform's dev MinIO on this
 * box listens on loopback only, so a run against a rented server presigns
 * against `http://<host>:<port>` and this script relays that port to MinIO
 * for as long as the run lasts. `gs.ezpug.com` is the name that already
 * resolves here.
 */
const DEMO_RELAY_HOST = flags.get('demo-relay') ?? null
const GAMEMODE = flags.get('gamemode') ?? 'pug'
/**
 * The first synthetic SteamID64 a bot is known by — `EZPug.Sdk`'s `BotIdentity`,
 * the one rule the plugin, the harness and the sim all follow. A BigInt because
 * 17 digits do not survive a double.
 */
const BOT_STEAM_ID_BASE = 90000000000000000n
const MAP = flags.get('map') ?? 'de_dust2'
const ROUNDS = Number(flags.get('rounds') ?? 4)
/**
 * `bot_quota` — a head count, because `gamemodes/pug/cfg/ezpug/pug.cfg` puts
 * the server in `bot_quota_mode normal`. Ten is a full 5v5; the *when* of it is
 * the interesting part and lives down in the poll loop.
 */
const BOTS = Number(flags.get('bots') ?? 10)
/**
 * **Puppets** (PRD-03 T5). `--simulate` turns {@link BOTS} anonymous bodies
 * into {@link BOTS} *rostered* ones: the request carries a roster of that many
 * SteamIDs and `simulation`, the orchestrator writes `simulation: true` into
 * the match file, and MatchZy-Enhanced's simulation mode spawns one bot per
 * roster entry, maps it to that SteamID and readies it up through
 * `OnPlayerReady` — the same handler `.ready` calls
 * (`references/MatchZy-Enhanced/src/SimulationMode.cs` `StartSimulationReadyFlow`).
 *
 * That is the whole point of the flag: the match goes live because ten players
 * readied, not because this script typed `css_start` at a server full of
 * strangers. Everything on the path — the ready gate T1 fixed, the auto-ready
 * and the side timer T3a turned on, the ready events T3 gave the vocabulary —
 * is only ever exercised here.
 */
const SIMULATE = flags.get('simulate') === 'true'
/**
 * `simulation.timeScale`, unsaid by default. The fork applies it as
 * `host_timescale` under `sv_cheats 1` and clamps it to 0.1–10
 * (`MatchLogic.cs`), which is where the contract's bounds come from; the
 * lane's own speed is PRD-03 T13's to choose, and a first recording is worth
 * more at the speed a human would watch.
 */
const TIMESCALE = flags.has('timescale') ? Number(flags.get('timescale')) : null
/**
 * **`simulation.scenario`** (PRD-03 T11): one scenario language, so the name
 * a request sends here is the one the simulator plays on the `sim` provider —
 * which is how this script proves the two tell the same story about the same
 * scenario (`--provider sim` beside a run on the dev node). The knobs are
 * resolved by the orchestrator and travel to the server as `assign.puppets`;
 * a scenario whose knobs no real server can execute is `validation_failed` on
 * this field rather than a knob that quietly did nothing.
 */
const SCENARIO = flags.get('scenario') ?? null
/**
 * **The escape hatch, named** (PRD-03, Attitude 2). An unrostered bot never
 * types `.ready`, so a `matchzy` match with nobody on the roster can only be
 * started over RCON — `bot_kick; bot_quota 0`, `css_start`, the quota back,
 * `mp_warmup_end`. That is four assertions skipped, and it used to be what
 * every recording on this box was made of. It still has its uses (a mode's
 * cfg, a map, a cvar, with nothing to prove about ready-up), so it stays —
 * behind a flag nobody passes by accident.
 */
const FORCE_START = flags.get('force-start') === 'true'
if (TIMESCALE !== null && !SIMULATE) die('--timescale is simulation’s: pass --simulate')
if (TIMESCALE !== null && !(TIMESCALE >= 0.1 && TIMESCALE <= 10))
  die('--timescale is between 0.1 and 10 (what the fork clamps host_timescale to)')
if (SIMULATE && FORCE_START)
  die('--simulate and --force-start are two answers to the same question: puppets ready themselves')
if (SIMULATE && BOTS < 1) die('--simulate needs bodies: --bots 1 or more')
if (SCENARIO !== null && !SIMULATE) die('--scenario is simulation’s: pass --simulate')
/**
 * The puppets' identities, from the fixtures' own
 * (`@ezpug/match-api/fixtures`): tk and maex, then their neighbours. They are
 * rostered alternately so team A always opens with tk and team B with maex —
 * which is what lets a recording of this run be read straight into the
 * MatchZy door's fixtures, whose context rosters exactly that way, and it
 * makes an odd `--bots` an uneven match (3 is a 2v1) rather than a refusal.
 */
const PUPPET_STEAM_ID_BASE = 76561198279375306n
const PUPPET_NAMES = ['tk', 'maex']
function puppetRoster(count) {
  const teams = { teamA: [], teamB: [] }
  for (let index = 0; index < count; index++) {
    const side = index % 2 === 0 ? teams.teamA : teams.teamB
    side.push({
      steamId64: String(PUPPET_STEAM_ID_BASE + BigInt(index)),
      name: PUPPET_NAMES[index] ?? `puppet-${index + 1}`,
      // Bilingual where a human reads it (CLAUDE.md): half the room is
      // German, half English, so a warmup line has both to say.
      locale: index % 2 === 0 ? 'de' : 'en',
    })
  }
  return teams
}
/**
 * `rules.format` — the game the engine plays (PRD-03 T3b). `wingman` is
 * `game_mode 2`, which MatchZy sets from the match file and which costs one
 * map reload at the start; pair it with `--bots 4`, because the format seats
 * two a side and a full quota would stand around with nowhere to spawn.
 */
const FORMAT = flags.get('format') ?? 'competitive'
if (FORMAT !== 'competitive' && FORMAT !== 'wingman') die('--format is `competitive` or `wingman`')
/**
 * `maps[0].sides` — which side team A opens on, or `knife` to let a knife
 * round decide (PRD-03 T6).
 *
 * A knifed map is the one place a *room of puppets* differs from a room of
 * people in a way the server has to answer for: stock MatchZy waits for the
 * winner to type `.stay` or `.switch` and a bot never will, so the map would
 * hold the box until a human looked. MatchZy-Enhanced's side-selection timer
 * is what decides it instead, and T3a turned that on in the image's own cfg
 * for exactly this reason. So `--sides knife` is not a variation on the
 * recording: it is the assertion that the timer reaches a real server.
 */
const SIDES = flags.get('sides') ?? 'ct'
if (!['ct', 't', 'knife'].includes(SIDES)) die('--sides is `ct`, `t` or `knife`')
/**
 * **Pause and unpause, through the front door** (PRD-03 T6): two match
 * commands a few polls apart once the match is live, which is the path the
 * platform's admin console takes. The facts are the core plugin's
 * (`match_paused`, `match_unpaused`) — MatchZy's own pause events are dropped
 * at the door because the plugin already says it (T3) — so this is also the
 * one lane case that proves that decision on hardware.
 */
const PAUSE = flags.get('pause') === 'true'
/**
 * **A rewind through the front door** (PRD-04 T8): the moment the third
 * round ends, `restore` to round 2 — the platform's admin console's round
 * picker, and the LAN case of a round somebody's machine crashed in. The
 * answer is the server's (`applied` once the engine started round 2 again,
 * or a refusal with a word, like a pause), and a refusal that can pass —
 * halftime — is asked again. MatchZy then holds the restored round
 * (`matchzy_pause_after_restore`) until somebody unpauses it, and a puppet
 * never types `.unpause`, so the row lifts it with the Match API's own
 * `unpause` once the pause is in the log.
 */
const RESTORE = flags.get('restore') === 'true'
/** How many rounds are played before the rewind, and the round it rewinds to. */
const RESTORE_AFTER_ROUNDS = 3
const RESTORE_ROUND = 2
/** How long the row waits on the stream for the round it asks after. */
const RESTORE_ROUND_WAIT_MS = 180_000
/** How long the row keeps asking while the refusal can still pass, and how long MatchZy's pause after the restore is given to show. */
const RESTORE_WINDOW_MS = 90_000
const RESTORE_PAUSE_MS = 20_000
/**
 * **A mixed roster** (PRD-04 T2): `--humans n` leaves the last `n` rostered
 * entries to people, so `simulation.puppets` names only the first
 * `BOTS - n` and their chairs stay empty for the whole run — a simulated
 * server has nobody at the keyboard, and the lane has no CS2 client of its
 * own. What the row proves is the negative: the puppeteer seats exactly who
 * is named, the person's SteamID is never announced, and a body that turns up
 * later (`--stand-in`, a `bot_add` over RCON, the one command the row types)
 * is a plain bot and not the person. Only a mode whose manifest claims
 * `capabilities.mixedRoster` takes such a request. `pug` does since PRD-04
 * T2b, on our fork of MatchZy-Enhanced: there the stand-in comes in warmup
 * rather than live, because the ready gate is waiting for it
 * ({@link GATE_HOLD_MS}).
 */
const HUMANS = Number(flags.get('humans') ?? 0)
if (!Number.isInteger(HUMANS) || HUMANS < 0) die('--humans is a whole number')
if (HUMANS > 0 && !SIMULATE) die('--humans is simulation’s: pass --simulate')
if (HUMANS > 0 && HUMANS >= BOTS) die('--humans leaves no puppet: keep it below --bots')
const STAND_IN = flags.get('stand-in') === 'true'
if (STAND_IN && HUMANS === 0) die('--stand-in stands in for a person: pass --humans')
/** How long after going live the stand-in is added: past the puppeteer's own seating, so the arrival is unmistakably not one it asked for. */
const STAND_IN_AFTER_MS = 15_000
/**
 * **`--hold`: a person's seat under MatchZy, held and then given up on**
 * (PRD-04 T2b). Our fork of MatchZy-Enhanced spawns a bot for every seat
 * but the person's, readies them, and then waits at the ordinary ready gate:
 * nothing marks a team ready on the person's behalf and the watchdog never
 * starts without them. The lane has no CS2 client, and **nothing else can
 * take the seat**: a plain bot fires no `player_connect_full` and MatchZy's
 * team hook skips bots, so only the simulation's own mapping ever puts a bot
 * into the players the gate counts (measured on the dev node, 2026-09-23: a
 * `bot_add_t` stand-in connected and the T side stayed at 4 of 5 for the rest
 * of the run). So the row proves the hold, and a client's answer to a
 * no-show, `cancel`; the arrival is a person's to prove
 * (`ralph/OPEN-POINTS.md`).
 */
const HOLD = flags.get('hold') === 'true'
if (HOLD && HUMANS === 0) die('--hold holds a seat for a person: pass --humans')
/**
 * **How long a `matchzy` room of ready puppets is held for the person**
 * before the run calls it off. Our fork's warmup watchdog reconciles 60 real
 * seconds after simulation mode starts and every 65 s after, and upstream
 * force-starts on its second pass, about two minutes in, whoever is missing.
 * Counted from the last puppet's `player_ready`, which is already some
 * seconds past that start, two and a half minutes is past the moment an
 * unpatched fork would have gone live without the person.
 */
const GATE_HOLD_MS = 150_000
/**
 * **How long the row keeps asking for its pause** (PRD-04 T4). It no longer
 * hopes: a pause MatchZy refuses now comes back `rejected` with a reason word,
 * so the row asks again the moment it is told no, and only for as long as the
 * reason can still pass — a halftime at timescale 2 is over well inside this.
 * An answer that is not a refusal ends the asking, whichever way it went.
 */
const PAUSE_WINDOW_MS = 90_000
const PAUSE_GAP_MS = 3_000
/** How long the `match_paused` fact is given to catch up with the answer that already believed it. */
const PAUSE_FACT_MS = 15_000
/**
 * **One puppet leaves and comes back, by the front door** (PRD-03 T6, T7a),
 * while the match is still in warmup — because that is the only window in
 * which a missing rostered player changes anything:
 * `AreAllConfiguredPlayersConnectedAndOnCorrectTeams` holds a loaded match at
 * the gate while any rostered SteamID is absent (T3a's sentence, T5a's note),
 * and nothing else in the fork cares.
 *
 * **The stimulus is a `kick` for the SteamID the request rostered**, which is
 * the only id a client ever holds, and the whole point of the case is that it
 * lands. It did not used to: `kick` is gated on the orchestrator's presence
 * map, that map is filled from `player_connected` / `player_disconnected`, and
 * the core plugin emitted those for humans only — so for a room of puppets it
 * was empty and no player command could reach any of them. T7 closed that for
 * the modes the SDK seats itself; **T7a closed it under MatchZy**, by reading
 * simulation mode's own console lines for which bot plays which roster entry
 * and casting the bodies from them. So this case types nothing at the server
 * any more, whatever the flow, and `cs2.extended.test.ts` declares its `rcon`
 * count as zero.
 *
 * The return is the fork's reconcile pass: the room goes one short, it adds a
 * bot on the side whose roster slot is empty, maps it onto that entry and
 * re-readies it — and the match goes live, which it could not do while a
 * rostered SteamID was missing.
 */
const DROP_PUPPET = flags.get('drop-puppet') === 'true'
if (DROP_PUPPET && !SIMULATE) die('--drop-puppet needs puppets: pass --simulate')
/** How long `--drop-puppet` waits on the stream for the whole room to be announced. */
const ROOM_PATIENCE_MS = 120_000
/**
 * **A puppet taps the phone** (PRD-03 T8, decision 17), which until now only
 * the owner's finger had ever done: `POST /v1/matches/:id/player-tokens` for a
 * rostered SteamID, `GET /v1/widget` with that token in the first frame, and
 * the mode's own verb over it — the whole path from a phone to
 * `Gamemode.OnPlayerCommand` and back, on real hardware, with a bot for a
 * thumb.
 *
 * The three taps this makes, and why each one is a different assertion:
 *
 *  - **the grant** — {@link WIDGET_VERB} with {@link WIDGET_KIND}, which the
 *    SDK checks against the manifest (the verb, the args, the cooldown, the
 *    charge) before `powerup-dm` ever sees it, and which leaves a
 *    `plugin_event` in the durable log and — for `radar_peek` — a run of
 *    `push` frames on this socket and nobody else's;
 *  - **the corpse** — the same verb, fired the instant a `player_death` for
 *    this puppet arrives *on the widget socket itself*, because a phone sees
 *    the match it is a phone for. A charge is spent per life, so the grant's
 *    own life is out of charges and it is the life after it that can be
 *    refused `not_alive`;
 *  - **the stranger** — a SteamID the request never rostered. `powerup-dm`
 *    opens its roster (`slots.openJoin`), so the *token* is minted for
 *    anybody, which is the half of "unless the mode is open-join" a run on
 *    this mode can prove; the tap is then the SDK's to refuse, because no
 *    body on the server answers for that id.
 */
const WIDGET = flags.get('widget') === 'true'
if (WIDGET && !SIMULATE) die('--widget needs a puppet whose phone to be: pass --simulate')
/** The verb the widget taps, and the kind it asks for. `powerup-dm`'s, the only mode with a phone. */
const WIDGET_VERB = 'powerup'
/**
 * `radar_peek` rather than `speed` or `armor` on purpose: it is the one kind
 * that answers *back*, ten `push` frames over five seconds to the one phone
 * that asked (PRD-02 T26), so a single tap proves both directions of the
 * socket instead of one.
 */
const WIDGET_KIND = 'radar_peek'
/** The `plugin_event` the mode leaves in the durable log when a power-up is claimed. */
const WIDGET_CLAIMED = 'powerup_claimed'
/** A SteamID64 nobody on this run is: the stranger's. */
const WIDGET_STRANGER = '76561198000000042'
/** How long a tap may take before the run stops waiting for its `command_result`. */
const WIDGET_TAP_MS = 15_000
/**
 * How often the grant is asked again when it met a corpse, and how far apart.
 * A body in `powerup-dm` is back within a second or two of dying, so eight
 * tries a second apart cover a respawn many times over (PRD-03 T18).
 */
const WIDGET_GRANT_TRIES = 8
const WIDGET_GRANT_RETRY_MS = 1_000
/**
 * **The movement spike** (PRD-03 T12), and the only row of this lane that
 * types at a match on purpose. The question is whether a puppet moved by
 * `Teleport` once an engine frame comes out of the Match API's stream looking
 * like a player moving — because if it does, a round of positions parsed out
 * of a real demo could be replayed by puppets and a radar could be developed
 * against it without a single human on a server.
 *
 * There is no front door for "walk here" and inventing one would be a contract
 * this spike has not earned, so the stimulus is the server console's own
 * `ezpug_walk` over RCON, and the row declares its one command. What is
 * measured is not the console's answer but what a *client* sees: the
 * `position_tick`s the stream carries, held against the path that was asked
 * for and against the same bodies moving themselves a few seconds earlier.
 */
const WALK_SECONDS = Number(flags.get('walk') ?? 0)
if (WALK_SECONDS > 0 && !SIMULATE) die('--walk moves puppets and nothing else: pass --simulate')
/**
 * **A run, at the speed this server is running.** 250 units a second is a CS
 * player's run in *game* time; the SDK's clock is a stopwatch
 * (`GameThreadClock`), so it samples positions every 100 ms of **wall** time
 * however fast `host_timescale` is driving the engine — and a body running
 * beside the walk therefore covers the lane's time scale times as much ground
 * between two samples. The walk is asked for that same apparent speed, so the
 * two windows below are comparable rather than a measurement of the time
 * scale. The circle is small enough to stay in one room.
 */
const WALK_SPEED = 250 * (TIMESCALE ?? 1)
const WALK_RADIUS = 128
/** How long the engine's own bots are watched first, so the walk has something to be unlike. */
const WALK_BASELINE_MS = 10_000
/**
 * **`rules.warmup.minPlayersToReady`, and the one way to play the floor**
 * (PRD-03 T5a). On the wire it is the whole match's count; the MatchZy
 * builder halves it per team, caps it at `players_per_team` and writes it
 * into the match file, and MatchZy-Enhanced's `IsTeamReady` then passes a
 * side the moment that many of its bodies are ready — its fifth still
 * silent. `0`, the default and what every recording before T5a was made
 * with, is the fork's "everybody connected must ready" and leaves the door
 * holding a `team_ready` against the roster alone.
 *
 * It is never a way to start a match short-handed: the fork still wants
 * `players_per_team` bodies on the side and every rostered SteamID connected
 * (`AreAllConfiguredPlayersConnectedAndOnCorrectTeams`), so a player who
 * never arrives holds the match in warmup whatever this says.
 */
const READY_GATE = flags.has('ready-gate') ? Number(flags.get('ready-gate')) : 0
if (!Number.isInteger(READY_GATE) || READY_GATE < 0)
  die('--ready-gate is a whole number of players across both teams, 0 or more')
if (READY_GATE > BOTS && SIMULATE)
  die(
    `--ready-gate ${READY_GATE} is above the ${BOTS} puppets on the roster: nobody could reach it`,
  )
const WANT_DEMO = flags.get('no-demo') !== 'true'
/**
 * Overtime is **on** by default and that is a finding, not a preference: with
 * an even `mp_maxrounds` and no overtime a map can end 2–2, and MatchZy reads
 * a drawn map in a Bo1 as a series nobody has won yet — `HandleMatchEnd` logs
 * `remainingMaps: 1` and replays the same map instead of sending `series_end`
 * (seen on this box). A recording that hangs is not a recording.
 */
const OVERTIME = flags.get('no-overtime') !== 'true'
const WRITE_FIXTURES = flags.get('write-fixtures') === 'true'
/**
 * What the written fixtures are called. `real-` is a match on the dev node
 * (T13); `dathost-` is the same recorder against a box rented in a datacentre
 * and reached over the public internet (T36). Both are recordings of hardware
 * and neither is regenerated from code, which is what
 * `packages/match-api/src/fixtures/recorded.test.ts` sorts them by.
 */
const FIXTURE_PREFIX = flags.get('fixture-prefix') ?? 'real'
const TIMEOUT_MS = Number(flags.get('timeout-minutes') ?? 45) * 60_000
/**
 * **The lane lock** (PRD-03 T13). There is one CS2 install on this box and two
 * loops that play matches on it — this repo's `EZPUG_CS2_TESTS` lane and the
 * platform's (its PRD-10 T9) — so a run that may land on the node provider
 * takes a file first and waits for whoever has it.
 *
 * A run that **pins** a provider which is not `nodes` touches no container
 * here (`--provider sim` is the simulator, and the Dathost smoke rents its own
 * box), so it takes nothing: the `idle` row's second leg would otherwise queue
 * behind the matrix for no reason. Everything else takes it, including a run
 * that pins nothing, because "probably not the dev node" is not an answer a
 * lock can be built on.
 */
const LOCK = flags.get('no-lock') !== 'true' && (PROVIDER === null || PROVIDER === 'nodes')
const LOCK_WAIT_MS = Number(flags.get('lock-wait') ?? 45) * 60_000
/** How long a run that took the lane waits for the last holder's server to leave the fleet. */
const LANE_DRAIN_MS = 10 * 60_000
/**
 * The orchestrator's trace, found rather than assumed. A **relative**
 * `EZPUG_IRON_TRACE_FILE` — which is what `.env.example` and
 * `docs/operations.md` both show — is resolved by each process against its own
 * working directory, and the orchestrator's is its package (`pnpm dev` runs the
 * task there, `pnpm --filter … start` too) while this script's is the repo. So
 * both are looked in, and neither existing is fatal below rather than a run
 * that plays a whole match and records an empty conversation. **When both
 * exist the one written last wins** (PRD-03 T2): a trace left at the repo root
 * on 2026-09-07 was preferred over the one the orchestrator was writing, and a
 * whole match on real hardware recorded zero link frames.
 */
const TRACE_FLAG =
  flags.get('no-trace') === 'true'
    ? null
    : (flags.get('trace') ?? process.env.EZPUG_IRON_TRACE_FILE ?? null)
const TRACE_FILE = (() => {
  if (!TRACE_FLAG) return null
  if (isAbsolute(TRACE_FLAG)) return TRACE_FLAG
  const candidates = [join(repo, TRACE_FLAG), join(repo, 'apps/orchestrator', TRACE_FLAG)]
  const written = candidates
    .filter(path => existsSync(path))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  return written[0] ?? candidates[0]
})()
/**
 * How long a live match may run before it is force-ended.
 *
 * A four-round match with bots usually clinches at 3–1 and MatchZy sends
 * `series_end` by itself, which is the run worth recording. It does not
 * always: a 2–2 map goes to overtime, and the engine works its overtime
 * clinch out from the `mp_maxrounds 24` MatchZy's own `live.cfg` sets rather
 * than the 4 the match config re-applies a second later — so it plays on past
 * the point either side has won and a run can wander for half an hour. This
 * is the wall in front of that: the match ends `force_ended`, the ledger row
 * closes, and the summary says which of the two happened.
 */
// A match stays `live` past its own `series_end` while the orchestrator holds
// the server open for the demo (PRD-02 T21): GOTV records the delayed broadcast,
// so MatchZy stops recording a `tv_delay` after the last round and the plugin
// uploads what settles. The force-end is the wall for a match that wandered into
// overtime, and it has to sit above the play *plus* that window.
const MAX_LIVE_MS = Number(flags.get('max-live-minutes') ?? 35) * 60_000
/**
 * **The wall clock, in one place.** Everything else in this repo runs on the
 * injected clock from `@ezpug/core` and the determinism guard makes a bare
 * `Date.now()` an error — rightly, because anything that must reproduce must
 * be able to be moved through time. This script is the exception the guard's
 * escape hatch exists for: it drives a real CS2 server on real hardware in
 * real time, so its "wait for the bots" and "give up after twenty minutes"
 * are wall-clock facts with nothing to inject. It is confined here so there
 * is exactly one place to read, and the recordings it writes are rebased onto
 * a fixed epoch anyway (see {@link makeScrubber}).
 */
const wall = {
  // biome-ignore lint/plugin: an operator script driving real hardware in real time
  now: () => Date.now(),
  // biome-ignore lint/plugin: as above — a presigned URL is signed at a wall-clock instant
  at: () => new Date(),
  // biome-ignore lint/plugin: as above — there is no clock to arm a timer on
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
}

const RUN_ID = `iron-match-${wall.at().toISOString().replace(/[:.]/g, '-')}`
const RUNS_DIR = join(repo, '.cache/iron-match')
const OUT_DIR = flags.get('rebuild') ?? flags.get('out') ?? join(RUNS_DIR, RUN_ID)
/**
 * How many runs `.cache/iron-match` keeps (PRD-03 T15a): two passes of the
 * matrix, which is more than any `--rebuild` has ever reached back for. The
 * directory held 1.3 GB in 120 runs when the box last filled.
 */
const KEEP_RUNS = 30

/**
 * The newest {@link KEEP_RUNS} of this script's own run directories stay and
 * the rest go. Only names this script gives (`iron-match-<ISO instant>`, which
 * sort as they happened), and only in the default place: a run written with
 * `--out` is somebody's on purpose.
 */
function pruneRuns() {
  if (!existsSync(RUNS_DIR)) return
  const runs = readdirSync(RUNS_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^iron-match-\d{4}-/.test(entry.name))
    .map(entry => entry.name)
    .sort()
  for (const name of runs.slice(0, Math.max(0, runs.length - KEEP_RUNS)))
    rmSync(join(RUNS_DIR, name), { recursive: true, force: true })
}

if (!Number.isInteger(ROUNDS) || ROUNDS <= 0 || ROUNDS % 2 !== 0)
  die('--rounds must be a positive even number (the Match API refuses anything else)')

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

/** Every call this script made, in order — the `calls` half of the recording. */
const calls = []

/** How many times a `429` is waited out before a call is given up on. */
const RATE_LIMIT_RETRIES = 6

function makeApi(secret) {
  return async function api(method, path, body) {
    for (let attempt = 1; ; attempt++) {
      const response = await fetch(`${BASE_URL}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${secret}`,
          ...(body !== undefined && { 'content-type': 'application/json' }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      })
      const text = await response.text()
      const json = text ? JSON.parse(text) : null
      // **A 429 is a wait, not a failure** (`docs/match-api.md`). It matters
      // most in the cleanup: this script's last act is to release a running
      // CS2 server, and a run that had just been rate-limited used to give
      // that up and leave the container standing.
      if (response.status === 429 && attempt <= RATE_LIMIT_RETRIES) {
        const after =
          Number(response.headers.get('retry-after') ?? 1) * 1000 ||
          json?.error?.details?.retryAfterMs
        say(`rate limited on ${method} ${path.replace(/\?.*$/, '')}; waiting ${after} ms`)
        await wall.sleep(Math.min(Math.max(after, 250), 10_000))
        continue
      }
      calls.push({
        route: `${method} ${path.replace(/\?.*$/, '')}`,
        status: response.status,
        ok: response.ok,
        ...(body !== undefined && { request: body }),
        response: json,
      })
      if (!response.ok) {
        const detail = json?.error
          ? `${json.error.code}: ${json.error.message}`
          : text.slice(0, 200)
        throw new Error(`${method} ${path} → ${response.status} ${detail}`)
      }
      return json
    }
  }
}

/**
 * Mint a key from the box. The API's own `POST /v1/keys` needs a key with
 * `admin`, and the first one has to come from somewhere: the orchestrator's
 * `keys:mint` script is that somewhere, and it prints the secret once.
 */
function mintKey(name, scopes) {
  const result = spawnSync(
    'pnpm',
    [
      '--silent',
      '--filter',
      '@ezpug/orchestrator',
      'keys:mint',
      '--',
      '--name',
      name,
      '--scopes',
      scopes,
    ],
    { cwd: repo, encoding: 'utf8' },
  )
  const secret = (result.stdout ?? '').trim().split('\n').pop() ?? ''
  if (!secret.startsWith('ezik_'))
    die(`could not mint an API key (${(result.stderr ?? '').trim() || 'no output'})`)
  return secret
}

/**
 * **A phone, in about sixty lines** (PRD-03 T8): the widget socket as
 * `@ezpug/gamemode-kit` opens it, without the browser. `GET /v1/widget`, the
 * player token in the first frame and nowhere else — a query string would put
 * it in the orchestrator's request log — then the `hello` back with the mode's
 * verbs, `event` frames for every durable fact of the match, `push` frames the
 * mode addressed to this one player, and a `command_result` per tap.
 *
 * Frames are handed to listeners as they arrive rather than polled, because
 * the one tap this script cares about the timing of is fired *from* a frame:
 * a `player_death` for the puppet, answered before the engine respawns it.
 *
 * The token is never said out loud — not in a line, not in the summary, not in
 * the recording. What the run reports is that one was minted and when it dies.
 */
async function openPhone(token, who) {
  const socket = new WebSocket(`${BASE_URL.replace(/^http/, 'ws')}/v1/widget`)
  const frames = []
  const listeners = []
  let closure = null
  socket.on('message', data => {
    let frame
    try {
      frame = JSON.parse(data.toString())
    } catch {
      return
    }
    frames.push(frame)
    for (const listener of [...listeners]) listener(frame)
  })
  socket.on('close', (code, reason) => {
    closure = { code, reason: reason.toString() }
  })
  socket.on('error', error => say(`${who}'s phone: ${error.message}`))
  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  /** The first frame a predicate accepts, from here on or already in hand. */
  const next = (accepts, withinMs) =>
    new Promise(resolve => {
      const held = frames.find(accepts)
      if (held) return resolve(held)
      const listener = frame => {
        if (!accepts(frame)) return
        listeners.splice(listeners.indexOf(listener), 1)
        clearTimeout(timer)
        resolve(frame)
      }
      // biome-ignore lint/plugin: an operator script driving real hardware in real time
      const timer = setTimeout(() => {
        listeners.splice(listeners.indexOf(listener), 1)
        resolve(null)
      }, withinMs)
      listeners.push(listener)
    })
  socket.send(JSON.stringify({ type: 'hello', protocol: 1, token }))
  const welcome = await next(frame => frame.type === 'hello', WIDGET_TAP_MS)
  if (!welcome) die(`${who}'s phone was never greeted${closure ? ` (closed ${closure.code})` : ''}`)
  let taps = 0
  return {
    welcome,
    frames,
    /** Every frame from now on, as it arrives. */
    on: listener => listeners.push(listener),
    /** One tap, and the `command_result` that came back for it. */
    tap: async (command, args) => {
      const correlationId = `${RUN_ID}-tap-${who}-${++taps}`
      socket.send(JSON.stringify({ type: 'command', correlationId, command, args }))
      const answer = await next(
        frame => frame.type === 'command_result' && frame.correlationId === correlationId,
        WIDGET_TAP_MS,
      )
      return answer ?? { type: 'command_result', correlationId, command, status: 'no_answer' }
    },
    close: () => {
      if (socket.readyState === WebSocket.OPEN) socket.close(1000, 'done')
    },
  }
}

// ---------------------------------------------------------------------------
// The demo target: a presigned PUT into the platform's dev MinIO
// ---------------------------------------------------------------------------

/**
 * SigV4 for one request, by hand. The alternative is an SDK dependency in a
 * repo that has no other use for one; presigning is a hash chain and forty
 * lines. The credentials come from the platform's own `.env` on this box and
 * are never written anywhere — the URL that carries the signature is scrubbed
 * out of everything this script records.
 *
 * `method` is `PUT` for the demo target the assignment carries and `HEAD` for
 * reading the object back afterwards: a signature covers the verb, so the
 * check that the bytes landed has to be signed for the verb it uses.
 *
 * **`endpoint` is the host the signature is computed over**, and it is not
 * always the host the bytes are ultimately stored on. A relayed run signs for
 * the public door (`--demo-relay`) and the relay forwards the `Host` header
 * unchanged, so MinIO recomputes the same signature over the same name.
 */
function presignPut({
  endpoint,
  region,
  accessKey,
  secretKey,
  bucket,
  key,
  expiresIn = 3600,
  method = 'PUT',
  now,
}) {
  const url = new URL(`${endpoint.replace(/\/+$/, '')}/${bucket}/${key}`)
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')
  const date = stamp.slice(0, 8)
  const scope = `${date}/${region}/s3/aws4_request`
  const query = new URLSearchParams({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKey}/${scope}`,
    'X-Amz-Date': stamp,
    'X-Amz-Expires': String(expiresIn),
    'X-Amz-SignedHeaders': 'host',
  })
  const canonical = [
    method,
    url.pathname,
    [...query.entries()]
      .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join('&'),
    `host:${url.host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n')
  const toSign = [
    'AWS4-HMAC-SHA256',
    stamp,
    scope,
    createHash('sha256').update(canonical).digest('hex'),
  ].join('\n')
  let signing = Buffer.from(`AWS4${secretKey}`, 'utf8')
  for (const part of [date, region, 's3', 'aws4_request'])
    signing = createHmac('sha256', signing).update(part).digest()
  query.set('X-Amz-Signature', createHmac('sha256', signing).update(toSign).digest('hex'))
  url.search = query.toString()
  return url.toString()
}

/** The platform's dev world is beside this one on this box; read its S3 settings, never copy them. */
function platformS3() {
  const env = {}
  try {
    for (const line of readFileSync('/root/ezpug/.env', 'utf8').split('\n')) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
      if (match) env[match[1]] = match[2].replace(/^["']|["']$/g, '')
    }
  } catch {
    return null
  }
  if (!env.EZPUG_S3_ENDPOINT || !env.EZPUG_S3_ACCESS_KEY || !env.EZPUG_S3_SECRET_KEY) return null
  return {
    endpoint: env.EZPUG_S3_ENDPOINT,
    region: env.EZPUG_S3_REGION || 'us-east-1',
    accessKey: env.EZPUG_S3_ACCESS_KEY,
    secretKey: env.EZPUG_S3_SECRET_KEY,
    bucket: (env.EZPUG_S3_BUCKETS || 'demos').split(',')[0].trim(),
  }
}

/**
 * **A door a datacentre can knock on** (PRD-02 T36).
 *
 * The demo is uploaded by the plugin on the game server, so a match on a
 * rented box PUTs from the public internet — and the platform's dev MinIO on
 * this box is published to loopback and nothing else, which is right and
 * should stay that way. This is the relay in between: a socket on every
 * interface for the length of one run, forwarding the method, the path, the
 * query and the body to MinIO **with the `Host` header the client sent**,
 * because that name is inside the SigV4 signature and MinIO recomputes it.
 *
 * It authenticates nobody, and does not have to: what it forwards is verified
 * by MinIO against a signature this run drew for one object key, one verb and
 * a few hours, and a request without one is a 403 from MinIO rather than from
 * here. It also carries no credential of its own — the signature is in the
 * URL the plugin was handed and never in this process's headers.
 *
 * What it saw is the run's evidence that the upload happened at all, which is
 * the half a client cannot see: `match.ended` reports what the *plugin*
 * believed, and this is the byte count that arrived.
 */
function startDemoRelay(target) {
  const seen = []
  const upstream = new URL(target)
  const server = createServer((request, response) => {
    const record = { method: request.method, path: request.url.split('?')[0], bytes: 0, status: 0 }
    // `node:http` and not `fetch`, for one reason: **the `Host` header has to
    // be forwarded verbatim**, it is inside the SigV4 signature MinIO
    // recomputes, and undici will not let a caller set it. Piped rather than
    // buffered, because a demo is tens of megabytes.
    const forwarded = httpRequest(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port || 80,
        method: request.method,
        path: request.url,
        headers: {
          ...(request.headers.host && { host: request.headers.host }),
          ...(request.headers['content-type'] && {
            'content-type': request.headers['content-type'],
          }),
          ...(request.headers['content-length'] && {
            'content-length': request.headers['content-length'],
          }),
        },
      },
      answer => {
        record.status = answer.statusCode ?? 0
        response.writeHead(answer.statusCode ?? 502, {
          'content-type': answer.headers['content-type'] ?? 'application/xml',
        })
        answer.pipe(response)
        answer.on('end', () => {
          seen.push(record)
          say(`demo relay: ${record.method} ${record.path} ${record.bytes} B -> ${record.status}`)
        })
      },
    )
    forwarded.on('error', error => {
      record.error = error.message
      seen.push(record)
      say(`demo relay: ${record.method} ${record.path} upstream error — ${error.message}`)
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain' })
      response.end('relay: upstream unreachable')
    })
    request.on('data', chunk => {
      record.bytes += chunk.length
    })
    request.pipe(forwarded)
  })
  return { server, seen }
}

// ---------------------------------------------------------------------------
// The trace: the orchestrator's own recording of what no client can see
// ---------------------------------------------------------------------------

function traceOffset() {
  if (!TRACE_FILE) return null
  try {
    return statSync(TRACE_FILE).size
  } catch {
    return 0
  }
}

function readTrace(from) {
  if (!TRACE_FILE || from === null) return []
  let text = ''
  try {
    text = readFileSync(TRACE_FILE, 'utf8').slice(from)
  } catch {
    return []
  }
  return text
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

// ---------------------------------------------------------------------------
// Scrubbing: no secret, no address, no wall clock, no random id
// ---------------------------------------------------------------------------

/** Where every recorded timestamp is rebased to, so two runs write the same bytes. */
const FIXTURE_EPOCH = Date.parse('2026-01-01T00:00:00.000Z')

/**
 * `FIXTURE_MATCH_ID` from `@ezpug/match-api/fixtures` — the id every recorded
 * file in this repo calls the match it is about.
 */
const FIXTURE_MATCH_ID = '6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b'

/**
 * Replace every identity and every timestamp with a stable one. `identities`
 * maps a real string to its fixture form; `origin` is the wall clock the
 * timestamps are measured from. Timestamps are *rebased*, not made relative:
 * a fixture whose `at` no longer parses as a date is a fixture no schema
 * accepts, and the deltas are the fact worth keeping.
 */
function makeScrubber(identities, origin, numbers = new Map()) {
  const uuids = new Map(Object.entries(identities))
  let anonymous = 0
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/
  const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g
  /** This service's token grammar (`apps/orchestrator/src/tokens.ts`), anywhere in any string. */
  const TOKENS = /ezi[kesnp]_[A-Za-z0-9_-]{8,}/g
  /**
   * Keys whose value is a secret whatever it looks like. A link token is
   * replaced by something **the protocol's own schema still accepts** —
   * `linkTokenSchema` wants sixteen characters, and a fixture whose `hello`
   * no longer parses proves nothing — carrying the mark every fixture in this
   * repo uses to say it is not one (`FIXTURE_TOKEN_MARK`).
   */
  const SECRET_KEYS = new Map([
    ['secret', '<redacted>'],
    // Not a secret — it is what `keys list` shows an operator — but twelve
    // characters of a real key have no business in a committed file.
    ['prefix', '<redacted>'],
    ['apiKey', '<redacted>'],
    ['password', '<redacted>'],
    ['token', 'not-a-secret_recorded_link_token'],
    ['serverToken', 'not-a-secret_recorded_server_token'],
    ['nodeToken', 'not-a-secret_recorded_node_token'],
  ])
  /** A presigned PUT: the path is a fact, the query is a signature. */
  const PRESIGNED_KEYS = new Set(['demoUploadUrl'])
  const REDACTED = '<redacted>'

  const string = value => {
    const mapped = uuids.get(value)
    if (mapped !== undefined) return mapped
    // `replace` and not `test`: a global regex carries `lastIndex` between
    // calls and would skip every other match.
    const detokenised = value.replace(TOKENS, REDACTED)
    if (detokenised !== value) return detokenised
    if (UUID.test(value)) {
      anonymous += 1
      const fixture = `00000000-0000-4000-8000-${String(anonymous).padStart(12, '0')}`
      uuids.set(value, fixture)
      return fixture
    }
    if (ISO.test(value)) {
      const rebased = new Date(FIXTURE_EPOCH + (Date.parse(value) - origin))
      return rebased.toISOString()
    }
    let out = value
    for (const [real, fixture] of uuids) if (out.includes(real)) out = out.replaceAll(real, fixture)
    return out.replace(IPV4, '127.0.0.1')
  }

  const walk = value => {
    if (typeof value === 'string') return string(value)
    if (typeof value === 'number') return numbers.get(value) ?? value
    if (Array.isArray(value)) return value.map(walk)
    if (value && typeof value === 'object') {
      const out = {}
      for (const [key, item] of Object.entries(value)) {
        if (SECRET_KEYS.has(key) && typeof item === 'string') out[key] = SECRET_KEYS.get(key)
        else if (PRESIGNED_KEYS.has(key) && typeof item === 'string')
          out[key] = `${item.split('?')[0]}?${REDACTED}`
        else out[key] = walk(item)
      }
      return out
    }
    return value
  }
  return walk
}

/** `matchzySerial` from `apps/orchestrator/src/match-config/matchzy.ts`, verbatim. */
function matchzySerial(matchId) {
  const serial = createHash('sha256').update(matchId).digest().readUInt32BE(0) & 0x7fff_ffff
  return serial === 0 ? 1 : serial
}

/** The canonical bytes every fixture file in this repo is written in. */
function stringify(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const cleanups = []
let cleaning = false
async function cleanUp() {
  if (cleaning) return
  cleaning = true
  for (const step of cleanups.reverse()) {
    try {
      await step()
    } catch (error) {
      say(`cleanup: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

// A Ctrl-C is not a licence to leave a CS2 container running and a ledger row
// open: the same cleanup the happy path runs, then the signal's exit code.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    say(`${signal}: cleaning up`)
    void cleanUp().finally(() => process.exit(130))
  })
}

async function run() {
  // 0. **The lane, before the clock starts** (PRD-03 T13). Taken ahead of
  //    `startedAt` on purpose: the wait for another loop's match is not part
  //    of this run's own `--timeout-minutes`, and the ledger window below
  //    would otherwise open while somebody else's server was still up.
  let lane = null
  if (LOCK) {
    let told = -1
    lane = await takeLaneLock({
      holder: 'ezpug-iron',
      what: `${RUN_ID} — ${GAMEMODE}, ${BOTS} ${SIMULATE ? 'puppets' : 'bodies'}`,
      waitMs: LOCK_WAIT_MS,
      clock: wall,
      onWait: ({ held, broke, ahead, waitedMs }) => {
        if (broke)
          return say(
            `the CS2 lane was held by a run that is gone (${describeLaneLock(held)}) — taking it`,
          )
        // Once when the wait starts, then once a minute: a lane that queues
        // behind the other loop for twenty minutes should say so, and not
        // twelve times a minute.
        const minutes = Math.floor(waitedMs / 60_000)
        if (minutes === told) return
        told = minutes
        // Behind a queue, the lane can be free and still not ours: whoever
        // asked first goes first (docs/operations.md, "The lane lock").
        say(
          `waiting for the CS2 lane — held by ${describeLaneLock(held)}` +
            (ahead.length > 0 ? `, ${describeLaneQueue(ahead)} ahead of this run` : ''),
        )
      },
    })
    cleanups.push(() => {
      if (lane.release()) say('released the CS2 lane')
    })
    say(
      lane.waitedMs > 1_000
        ? `took the CS2 lane after ${Math.round(lane.waitedMs / 1_000)}s`
        : 'took the CS2 lane',
    )
  }

  // `let` because a wait for the last holder's server (1a) restarts it.
  let startedAt = wall.now()
  const traceFrom = traceOffset()
  if (TRACE_FILE) {
    // **A named trace that is not there is a stop, not a shrug.** Without this
    // the run plays a whole match and then writes an empty `LinkExchange` over
    // a good fixture — "verified" by nobody, which is the one thing this
    // recording exists not to be.
    if (!existsSync(TRACE_FILE))
      die(
        `no trace at ${TRACE_FILE} (nor under apps/orchestrator/) — start the ` +
          'orchestrator with EZPUG_IRON_TRACE_FILE set and let it write at least one ' +
          'frame before recording a match.',
      )
    say(`recording the orchestrator's trace from ${TRACE_FILE}`)
  } else
    say(
      'no trace file: link frames and MatchZy payloads will not be recorded ' +
        '(start the orchestrator with EZPUG_IRON_TRACE_FILE=<file>)',
    )

  // 1. A key of this run's own, with a webhook secret nobody else holds.
  //    The admin key it is minted with is either the operator's — the only
  //    way in to a deployment whose database this checkout cannot open — or
  //    one minted from the box, which is what a dev run does.
  const adminSecret = ADMIN_KEY ?? mintKey(`${RUN_ID}-admin`, 'admin')
  const admin = makeApi(adminSecret)
  if (ADMIN_KEY) say(`using the admin key from the environment against ${BASE_URL}`)
  const webhookSecret = `iron-match-${randomUUID()}`
  const created = await admin('POST', '/v1/keys', {
    name: RUN_ID,
    // `simulation` only when this run means to ask for puppets (PRD-03 T4):
    // the scope is what keeps a production key from ever playing one, and a
    // run that holds it without needing it proves nothing about the door.
    scopes: ['matches', 'fleet', 'admin', ...(SIMULATE ? ['simulation'] : [])],
    budget: {
      maxConcurrentServers: 2,
      maxServerLifetimeMinutes: 60,
      // **Zero is a ceiling of zero, not the absence of one** (T37d): free
      // providers forever, `402 budget_exceeded` on the first paid box. That
      // is the right default for a run on the dev node and the wrong one for a
      // run that means to rent something, so `--budget-cents` is how a run
      // that spends money says how much.
      monthlyCents: BUDGET_CENTS,
    },
    webhookSecrets: [{ id: 'whsec-iron-match', secret: webhookSecret }],
  })
  const keyId = created.key.id
  const api = makeApi(created.secret)
  cleanups.push(async () => {
    await admin('DELETE', `/v1/keys/${keyId}`)
    say(`revoked the run's key`)
  })

  // 1a. **The lane is ours once the last holder's server has left** (PRD-03
  //     T18). The protocol says to release only after the server is gone
  //     (`docs/operations.md`). A holder that releases on its match's end
  //     leaves a server behind for minutes, and this run's end-of-match
  //     assertion counts every server on the fleet. So a run that took the
  //     lane waits for an empty fleet first, bounded, and names what it waited
  //     for. If the bound runs out it plays anyway, and that assertion says
  //     whose server was still there.
  if (lane) {
    const until = wall.now() + LANE_DRAIN_MS
    for (let told = ''; ; ) {
      const { servers } = await api('GET', '/v1/fleet/servers')
      if (servers.length === 0) break
      const who = servers.map(server => `${server.id} (match ${server.matchId})`).join(', ')
      if (who !== told) say(`the CS2 lane is ours, but the fleet still lists ${who} — waiting`)
      told = who
      if (wall.now() >= until) {
        say(`the fleet did not empty in ${LANE_DRAIN_MS / 60_000} minutes — playing anyway`)
        break
      }
      await wall.sleep(5_000)
    }
    // Somebody else's server is not this run's clock, any more than the lock
    // wait is, and the ledger window opens after it is gone.
    startedAt = wall.now()
  }

  // 2. The webhook endpoint, verified with the published verifier.
  const { verifyWebhook } = await matchApi()
  const deliveries = []
  const webhookServer = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => (body += chunk))
    request.on('end', async () => {
      // The bytes that arrived are what the HMAC is over — verified before
      // anything parses them, which is the rule the published verifier states.
      const verified = await verifyWebhook({
        headers: request.headers,
        body,
        secrets: { 'whsec-iron-match': webhookSecret },
        clock: wall,
      })
      deliveries.push({
        signature: verified.ok ? 'verified' : `refused: ${verified.reason}`,
        attempt: verified.ok ? verified.attempt : 1,
        envelope: verified.ok ? verified.envelope : JSON.parse(body),
      })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"ok":true}')
    })
  })
  await new Promise(resolve => webhookServer.listen(0, WEBHOOK_HOST, resolve))
  const webhookUrl = `http://${WEBHOOK_HOST}:${webhookServer.address().port}/webhook`
  cleanups.push(() => new Promise(resolve => webhookServer.close(resolve)))
  say(`webhook endpoint on ${webhookUrl}`)

  // 3. Where the demo goes: a presigned PUT into the platform's dev MinIO,
  //    directly from a server on this box or through the relay from one that
  //    is not.
  let demoUploadUrl
  const s3 = WANT_DEMO ? platformS3() : null
  let demoRelay = null
  const demoKey = `iron-match/${RUN_ID}.dem`
  if (WANT_DEMO && !s3)
    say('no S3 credentials beside this box: the match runs without a demo target')
  if (s3) {
    let signedEndpoint = s3.endpoint
    if (DEMO_RELAY_HOST) {
      demoRelay = startDemoRelay(s3.endpoint)
      // Every interface, because the client is a datacentre; an ephemeral
      // port, because the run is minutes long and nothing else may hold it.
      await new Promise(resolve => demoRelay.server.listen(0, '0.0.0.0', resolve))
      const port = demoRelay.server.address().port
      signedEndpoint = `http://${DEMO_RELAY_HOST}:${port}`
      cleanups.push(() => new Promise(resolve => demoRelay.server.close(resolve)))
      say(`demo relay on ${signedEndpoint} → ${s3.endpoint}`)
    }
    demoUploadUrl = presignPut({
      ...s3,
      endpoint: signedEndpoint,
      key: demoKey,
      expiresIn: 6 * 3600,
      now: wall.at(),
    })
    say(`demo target: ${signedEndpoint}/${s3.bucket}/${demoKey}`)
  }

  // 3b. **Who owns the flow.** A `matchzy` mode needs a `css_start` and an empty
  //     server before it (below); a `plugin` or `none` mode needs neither — the
  //     SDK's generic emitter reads the flow off the engine (PRD-02 T22), so the
  //     mode's own cfg decides when warmup ends and nothing here drives it. The
  //     catalog is asked rather than the checkout, because what the orchestrator
  //     serves is what the server was assigned.
  const catalog = await api('GET', '/v1/gamemodes')
  const manifest = catalog.gamemodes.find(mode => mode.id === GAMEMODE)
  if (!manifest) die(`the orchestrator serves no gamemode "${GAMEMODE}"`)
  const FLOW = manifest.flow
  // EZ Rating is drawn only where the manifest asks for it, and a bots run can
  // only push a profile into a roster that is open (T27, the step in the loop).
  const RATED = manifest.capabilities.scoreboardRating && manifest.slots.openJoin
  // **Skins over the link** (PRD-02 T28, decision 20): the orchestrator enables the
  // WeaponPaints fork only when a roster entry carries a loadout, so an open-join
  // run rosters one player nobody will be — a loadout on the request is what turns
  // the folder on — and pushes a loadout with every bot profile. What that proves
  // is the hand-off, seen as the core plugin's `skins:` console lines (below): a
  // bot is never dressed, by upstream's own `IsBot` checks, so the pixels are a
  // human's. Not on a `matchzy` flow: a rostered player MatchZy waits for would
  // stall a match that `css_start` is meant to start.
  const SKINNED = manifest.slots.openJoin && FLOW !== 'matchzy'
  // **A `matchzy` match with nobody on it has to say how it means to start**
  // (PRD-03 T5). MatchZy waits for its roster to ready up; an anonymous bot
  // never will, so such a match either rosters puppets (`--simulate`) or is
  // started over RCON with the escape hatch (`--force-start`). Neither, and
  // the run would sit in warmup until `--timeout-minutes` gave up — twenty
  // wasted minutes of a CS2 container, which is what this refusal buys back.
  if (FLOW === 'matchzy' && !SIMULATE && !FORCE_START)
    die(
      `${GAMEMODE} is a matchzy mode and nobody on this request readies up: ` +
        'pass --simulate for puppets that do, or --force-start for the RCON escape hatch',
    )
  if (SIMULATE && !manifest.capabilities.simulation)
    die(`${GAMEMODE} does not claim capabilities.simulation — the door would refuse the request`)
  if (HUMANS > 0 && !manifest.capabilities.mixedRoster)
    die(
      `${GAMEMODE} does not claim capabilities.mixedRoster — the door would refuse simulation.puppets on it`,
    )
  // MatchZy's gate counts only the bodies its connect and team hooks saw, and
  // both skip a plain bot, so a stand-in there is a bot nobody counts ({@link HOLD}).
  if (STAND_IN && FLOW === 'matchzy')
    die('--stand-in is for SDK flows: MatchZy never counts a plain bot at its gate — use --hold')
  if (HOLD && FLOW !== 'matchzy')
    die(
      `--hold holds MatchZy's ready gate, and ${GAMEMODE} has none: an SDK flow goes live on its own clock`,
    )
  // **A phone needs a mode that has one** (PRD-03 T8). The catalog is asked
  // rather than the checkout, and the verb too: the widget socket's `hello`
  // answers with the verbs the *served* manifest declares, and a tap for one
  // it does not is `unknown_command` at the door before any server sees it.
  if (WIDGET) {
    if (!manifest.capabilities.widget || !manifest.capabilities.playerCommands)
      die(`${GAMEMODE} declares no widget and no player commands — there is no phone to tap`)
    if (!manifest.commands.some(verb => verb.name === WIDGET_VERB))
      die(`${GAMEMODE} declares no \`${WIDGET_VERB}\` verb — --widget is powerup-dm's`)
  }
  /** The puppets, rostered (PRD-03 T5), or nobody. */
  const PUPPETS = SIMULATE ? puppetRoster(BOTS) : null
  /** The rostered SteamIDs a bot plays, and the ones left to people (`--humans`): the last of the seating order. */
  const PUPPET_STEAM_IDS = PUPPETS
    ? Array.from({ length: BOTS - HUMANS }, (_, index) =>
        String(PUPPET_STEAM_ID_BASE + BigInt(index)),
      )
    : []
  const HUMAN_STEAM_IDS = PUPPETS
    ? Array.from({ length: HUMANS }, (_, index) =>
        String(PUPPET_STEAM_ID_BASE + BigInt(BOTS - HUMANS + index)),
      )
    : []
  if (PUPPETS)
    say(
      `puppets: ${PUPPETS.teamA.length}v${PUPPETS.teamB.length}` +
        `${TIMESCALE === null ? '' : ` at ${TIMESCALE}× engine time`}`,
    )
  /** The loadout every link fixture carries (`packages/protocol/src/fixtures.ts`): tk's karambit. */
  const LOADOUT = {
    t: {
      weapons: [
        {
          defindex: 7,
          paintId: 490,
          wear: 0.12,
          seed: 661,
          nametag: 'lauwarm',
          stattrak: true,
          stattrakCount: 1337,
          stickers: [{ id: 4, x: 0.5, y: -0.25 }],
          keychain: { id: 20, seed: 7 },
        },
      ],
      knife: 'weapon_knife_karambit',
      gloves: 5027,
      agent: 'customplayer_tm_leet_variantg',
      music: 3,
      pin: 874,
    },
    ct: { weapons: [{ defindex: 60, paintId: 1231 }] },
  }
  say(
    `gamemode ${GAMEMODE} v${manifest.version}: flow ${FLOW}, records ${manifest.records}, format ${FORMAT}`,
  )

  // 4. The request. Four rounds and overtime; who is on it depends on the run.
  //    Under `--simulate` it rosters puppets and asks for `simulation`, and
  //    MatchZy starts it because they ready up; with `--force-start` it rosters
  //    nobody and `css_start` starts it, because an anonymous bot never types
  //    `.ready`.
  const request = {
    clientMatchId: RUN_ID,
    game: 'cs2',
    gamemode: GAMEMODE,
    teams: {
      teamA: {
        name: 'EZPug A',
        // Puppets first (PRD-03 T5): under `--simulate` the roster is the
        // match, and every entry is a SteamID a bot will answer for.
        //
        // Otherwise the one rostered player, with a loadout, so the skins layer is enabled
        // (SKINNED, above). They never connect: the SteamID is the first bot identity's, which
        // the profile pushes below carry too, so the core holds exactly one loadout for it.
        players:
          PUPPETS?.teamA ??
          (SKINNED
            ? [
                {
                  steamId64: String(BOT_STEAM_ID_BASE),
                  name: 'EZ Bot 0',
                  locale: 'de',
                  loadout: LOADOUT,
                },
              ]
            : []),
      },
      teamB: { name: 'EZPug B', players: PUPPETS?.teamB ?? [] },
    },
    ...(SIMULATE && {
      simulation: {
        ...(TIMESCALE === null ? {} : { timeScale: TIMESCALE }),
        ...(SCENARIO === null ? {} : { scenario: SCENARIO }),
        // A mixed roster names its puppets (PRD-04 T2); an all-puppet one says nothing.
        ...(HUMANS > 0 ? { puppets: PUPPET_STEAM_IDS } : {}),
      },
    }),
    maps: [{ map: MAP, sides: SIDES }],
    rules: {
      format: FORMAT,
      regulationRounds: ROUNDS,
      // **Overtime is where the wall clock goes.** Ten bots are evenly matched,
      // so a four-round map draws 2-2 more often than not and the overtime
      // decides it: six more rounds, drawn again about a third of the time, six
      // more after that. Sixteen rounds at a minute and a half is why
      // {@link MAX_LIVE_MS} is thirty-five minutes rather than fifteen — a
      // match force-ended in the middle cuts GOTV off and the run records no
      // demo, which is the one thing this run exists to produce, and a run on
      // this box reached `series_end` eight seconds the wrong side of a
      // twenty-five minute wall. Two rounds of overtime was tried and is worse,
      // not better: one round a side splits 1-1 far more often than six rounds
      // split 3-3.
      overtime: { enabled: OVERTIME, maxRounds: 6, startMoney: 10_000 },
      warmup: { minPlayersToReady: READY_GATE, minSpectatorsToReady: 0 },
      // These travel in the match config, which MatchZy re-applies a second
      // after its own `live.cfg` — so the quota below is what the *match* runs
      // with whatever that cfg did to it. `bot_quota_mode` is deliberately not
      // among them: the mode is the server's, set once in `ezpug/pug.cfg` while
      // the server is empty, and changing it with bots standing evicts GOTV
      // along with them (PRD-02 T21a).
      cvars: {
        // **A short freeze time, and nothing else about the round.** Eighteen
        // seconds a round of bots standing still is four minutes of a run that
        // has to finish inside {@link MAX_LIVE_MS}; five is plenty for a buy
        // nobody makes. This travels in the match config, which MatchZy applies
        // *after* its own `live.cfg`, so it is the last word.
        //
        // **`mp_roundtime` is deliberately left alone.** Cutting it to a minute
        // was tried while the runs that motivated it were still losing every
        // round to the CT side on the clock — which turned out to be the bots
        // not fighting at all (`bot_quota_mode`, above), not the length of the
        // round. It was reverted rather than kept on a reason that had already
        // been shown to be something else; a shorter round is a change somebody
        // can make later, on a measurement of its own.
        mp_freezetime: '5',
        // **Not under `--simulate`: the bot population is the fork's there**
        // (PRD-03 T5). Simulation mode sets `bot_join_after_player 0`,
        // `bot_quota_mode normal` and `bot_difficulty 3` itself and then walks
        // `bot_quota` up from zero one puppet at a time, never back down,
        // precisely so a late quota cannot kick the bots it has already mapped
        // to roster slots (`SimulationMode.cs` `SpawnSimulationBots`). A
        // `bot_quota` in the match config is re-applied a second after
        // `live.cfg` and would land in the middle of that.
        ...(BOTS > 0 &&
          !SIMULATE && {
            bot_difficulty: '2',
            bot_join_after_player: '0',
            // **`bot_quota` travels here for every flow, which is the point of a request's
            // `rules.cvars`.** It did not always: the loader used to exec the mode's cfg and
            // set these cvars into the *same* console frame, and the engine reconciles the
            // bot population once at the end of one — so a `bot_kick` or a `bot_quota_mode`
            // switch in a mode's cfg evicted whoever was standing and a `bot_quota` beside
            // it could not bring them back. Measured on the dev node with
            // `flying-scoutsman`: bots kicked at 1.2 s, `going_live` at 21 s, an empty
            // server for twenty minutes — then one `bot_quota 10` over RCON and ten bots
            // inside a second. This script asked over RCON for a while because it could; a
            // client cannot, and must not have to. The loader gives the cfg a frame of its
            // own now and everything the assignment asks for the next
            // (`GamemodeLoader.CvarSettleMs`, PRD-02 T22a), so the quota simply arrives with
            // the map. A `matchzy` flow still dances in the poll loop below, for a different
            // reason: MatchZy's own `warmup.cfg` and `live.cfg` move the quota themselves.
            bot_quota: String(BOTS),
          }),
      },
    },
    requirements: { lan: LAN, ...(PROVIDER && { provider: PROVIDER }) },
    callbacks: {
      webhookUrl,
      webhookSecretId: 'whsec-iron-match',
      ...(demoUploadUrl && { demoUploadUrl }),
    },
    warmupLines: ['Willkommen bei EZPug.', 'Welcome to EZPug.'],
    branding: { hostname: `EZPug · ${GAMEMODE} · ${MAP}`, eventName: 'iron-match' },
    ttlMinutes: 60,
  }

  const match = await api('POST', '/v1/matches', request)
  const matchId = match.id
  say(`match ${matchId} created (${match.state})`)
  // The server is money and a running CS2 container either way: whatever
  // happens below, this match does not outlive the run.
  cleanups.push(async () => {
    const latest = await api('GET', `/v1/matches/${matchId}`)
    if (['ended', 'failed', 'cancelled'].includes(latest.state)) return
    say(`cancelling ${matchId} (${latest.state})`)
    if (latest.state === 'live')
      await api('POST', `/v1/matches/${matchId}/commands`, {
        correlationId: `${RUN_ID}-force-end`,
        type: 'force_end',
        reason: 'the iron-match run is over',
      })
    else await api('POST', `/v1/matches/${matchId}/cancel`)
  })

  // 5. The stream, from the moment the match exists.
  const streamFrames = []
  /**
   * **The ephemeral tier, kept** — only for `--walk` (PRD-03 T12), because a
   * five-minute match is thousands of position ticks and nothing else in this
   * run has a use for one. Each tick keeps its arrival, and the ticks of one
   * frame keep their order: two samples of the same player in consecutive
   * ticks are 100 ms of engine time apart by construction
   * (`GamemodeRuntime.PositionTickIntervalMs`), which is the only clock the
   * vocabulary gives a position at all.
   */
  const radarSamples = []
  const socket = new WebSocket(`${BASE_URL.replace(/^http/, 'ws')}/v1/matches/${matchId}/stream`, {
    headers: { authorization: `Bearer ${created.secret}` },
  })
  socket.on('message', data => {
    try {
      const frame = JSON.parse(data.toString())
      streamFrames.push(frame)
      if (WALK_SECONDS > 0 && frame.type === 'tick')
        for (const tick of frame.ticks)
          radarSamples.push({ at: wall.now(), positions: tick.positions })
    } catch {
      // A frame that is not JSON is the orchestrator's problem, and it has none.
    }
  })
  socket.on('error', error => say(`stream: ${error.message}`))
  cleanups.push(() => {
    if (socket.readyState === WebSocket.OPEN) socket.close(1000, 'done')
  })

  // 6. Watch it play — and, under `--force-start` and only there, push it:
  //    nobody is rostered on such a run, so MatchZy waits for a `.ready` that
  //    will never come. A puppet match is watched and nothing else.
  const TERMINAL = ['ended', 'failed', 'cancelled']
  const rcon = (command, tag) =>
    api('POST', `/v1/matches/${matchId}/commands`, {
      correlationId: `${RUN_ID}-${tag}`,
      type: 'rcon',
      command,
    })
  /**
   * The `scoreboard:` line of `ezpug_status` — EZ Rating read back off the
   * controllers rather than off what was asked for (PRD-02 T27).
   *
   * Two doors, in this order and for a reason. RCON *runs* the command: a node
   * opens a Source RCON socket on the game port, which is the only way to make
   * the plugin print anything on demand. RCON does not *read* it: a
   * `SERVER_ONLY` CounterStrikeSharp command answers on the server console, so
   * the RCON reply is empty (measured here). The report also goes into the
   * plugin's console buffer, and `GET /v1/fleet/servers/:id/console` is what
   * hands that back. Null rather than a failure at every step — this is a check
   * on the way past, never a reason to lose a match.
   */
  const readScoreboard = async id => (await readScoreboardAt(id))?.line ?? null
  /**
   * The same read, with the console's own stamp on the line, and — given
   * `after`, the stamp of an earlier read — only a line newer than that one:
   * the tail keeps every earlier report, so a status the server had not
   * printed yet would otherwise read back as the previous one.
   */
  const readScoreboardAt = async (id, after = null) => {
    try {
      const rows = await api('GET', '/v1/fleet/servers')
      const row = rows.servers.find(server => server.matchId === id)
      if (!row) return null
      await api('POST', `/v1/fleet/servers/${row.id}/rcon`, { command: 'ezpug_status' })
      await wall.sleep(1_000)
      const tail = await api('GET', `/v1/fleet/servers/${row.id}/console`)
      const entry = tail.lines
        .filter(entry => entry.line.includes('scoreboard:'))
        .filter(entry => after === null || entry.at > after)
        .at(-1)
      return entry ? { at: entry.at, line: entry.line.trim() } : null
    } catch (error) {
      return { at: null, line: `unreadable: ${error.message}` }
    }
  }
  /**
   * **Where EZ Rating's number goes on a puppet** (PRD-04 T6, OPEN-POINTS §3).
   * A retakes scoreboard read `tk 0, maex 0, puppet-3 0` once, and two causes
   * fit: the engine clears the number at a spawn that runs after the
   * `round_start` redraw, or it never keeps one on a bot controller at all.
   * Three reads in one round tell them apart: the first the moment the
   * stream carries a `round_start` (the SDK draws, then emits, so the draw is
   * older than the fact), the second several seconds into the same round,
   * and the third just after the same profiles are pushed *again* mid-round,
   * which `RatingBoard.OnProfile` draws at once with no spawn anywhere near
   * it. A number that survives the first read and not the second was cleared
   * by something in the round; a zero on the third was never kept.
   */
  const probeRating = async (id, profiles) => {
    const rounds = () =>
      streamFrames.filter(
        frame => frame.type === 'event' && frame.envelope.payload.type === 'round_start',
      ).length
    const seen = rounds()
    const until = wall.now() + 90_000
    while (rounds() === seen && wall.now() < until) await wall.sleep(100)
    if (rounds() === seen) return { round: null, reads: [] }
    const roundAt = wall.now()
    // Nothing printed before this round counts: the orchestrator stamps a
    // console line when it lands, on this box's clock, so after the fact did.
    let after = wall.at().toISOString()
    const reads = []
    const read = async label => {
      const startedMs = wall.now() - roundAt
      const got = await readScoreboardAt(id, after)
      if (got?.at) after = got.at
      reads.push({ label, afterMs: startedMs, line: got?.line ?? null })
      say(
        `rating probe, ${label} (+${(startedMs / 1_000).toFixed(1)} s): ${got?.line ?? 'no new line'}`,
      )
    }
    await read('round_start')
    await wall.sleep(Math.max(0, 6_000 - (wall.now() - roundAt)))
    await read('mid-round')
    for (const [index, who] of profiles.entries())
      await api('POST', `/v1/matches/${id}/commands`, {
        correlationId: `${RUN_ID}-profile-again-${index}`,
        type: 'profile',
        player: { ...who, rating: 1000 + index * 111, rankName: 'Iron' },
      })
    await read('after a mid-round write')
    return { round: seen + 1, reads }
  }
  /**
   * **What the radar would draw**, out of the stream and nothing else
   * (PRD-03 T12). A window of position ticks becomes, per player, the steps
   * between one tick and the next — and only between *consecutive* ticks, so
   * a body that died and came back somewhere else contributes no step across
   * its own death. Each step is 100 ms of engine time, which makes the whole
   * distribution a speed in engine units a second.
   *
   * The numbers that say whether a path looks like a player: `median` (a run
   * is 250 u/s, so 25 units a step), `p95` and `max` (a snap the radar would
   * draw as a jump), `still` (the share of steps under a unit — a body
   * standing still, which the engine's own bots do constantly and a walked
   * puppet never does) and `spread`, p95 over median, which is one number for
   * how *even* the movement is.
   */
  const radarWindow = (from, to) => {
    const byPlayer = new Map()
    for (const [index, sample] of radarSamples.slice(from, to).entries())
      for (const position of sample.positions) {
        const seen = byPlayer.get(position.steamId64) ?? { at: -2, last: null, steps: [] }
        if (seen.at === index - 1 && seen.last)
          seen.steps.push(
            Math.hypot(
              position.x - seen.last.x,
              position.y - seen.last.y,
              position.z - seen.last.z,
            ),
          )
        byPlayer.set(position.steamId64, { at: index, last: position, steps: seen.steps })
      }
    const steps = [...byPlayer.values()].flatMap(player => player.steps).sort((a, b) => a - b)
    const at = fraction =>
      steps.length === 0
        ? null
        : steps[Math.min(steps.length - 1, Math.floor(fraction * steps.length))]
    const round = value => (value === null ? null : Math.round(value * 10) / 10)
    const median = at(0.5)
    return {
      samples: to - from,
      bodies: byPlayer.size,
      steps: steps.length,
      median: round(median),
      p95: round(at(0.95)),
      max: round(steps.at(-1) ?? null),
      still:
        steps.length === 0
          ? null
          : Math.round((steps.filter(step => step < 1).length / steps.length) * 100) / 100,
      spread: median ? Math.round((at(0.95) / median) * 100) / 100 : null,
    }
  }
  /**
   * **The spike, on hardware** (PRD-03 T12). The engine's own bots first, then
   * the same bodies on a circle nobody can argue with, measured through the
   * same socket a platform's radar would use. The console's `[walk]` lines are
   * read back afterwards as the server's own account of what it was asked to
   * do — how many bodies it moved, how many teleports it commanded, and how
   * many of them died and started a new circle where they woke up.
   */
  const measureWalk = async id => {
    const from = radarSamples.length
    const engineFrom = wall.now()
    say(`walk: watching the engine move the puppets for ${WALK_BASELINE_MS / 1000} s`)
    await wall.sleep(WALK_BASELINE_MS)
    const engineTo = wall.now()
    const engine = radarWindow(from, radarSamples.length)
    const asked = await rcon(`ezpug_walk ${WALK_SECONDS} ${WALK_SPEED} ${WALK_RADIUS}`, 'walk')
    // The command is `accepted` and runs a moment later; a second of grace, so
    // the window holds the walk and not the tail of the engine's own bots.
    await wall.sleep(1_000)
    const walkFrom = radarSamples.length
    const walkedFrom = wall.now()
    // Real seconds, like the walk's own clock.
    await wall.sleep(WALK_SECONDS * 1000)
    const walkedTo = wall.now()
    const teleported = radarWindow(walkFrom, radarSamples.length)
    say(`walk: engine ${stringify(engine).replace(/\s+/g, ' ')}`)
    say(`walk: teleported ${stringify(teleported).replace(/\s+/g, ' ')}`)
    let lines = []
    try {
      const rows = await api('GET', '/v1/fleet/servers')
      const row = rows.servers.find(server => server.matchId === id)
      if (row) {
        const tail = await api('GET', `/v1/fleet/servers/${row.id}/console`)
        lines = tail.lines.map(entry => entry.line.trim()).filter(line => line.includes('[walk]'))
      }
    } catch {
      // The console is a look on the way past, never a reason to lose a match.
    }
    return {
      seconds: WALK_SECONDS,
      speed: WALK_SPEED,
      radius: WALK_RADIUS,
      /** 25 units between two samples of a 250 u/s run — what the numbers are held against. */
      expectedStep: Math.round(((WALK_SPEED * 100) / 1000) * 10) / 10,
      /**
       * **The position ticker's period, as the stream shows it** (PRD-04 T5):
       * the median step over the commanded speed. A walked body covers
       * `speed` units a wall second, so a step of `speed / 10` is 100 ms
       * between two ticks and anything longer is the ticker running slow —
       * which it did, by a frame a tick, until `GameThreadClock.Every` began
       * re-arming from the due time (OPEN-POINTS §4 as it was: 108 ms).
       */
      intervalMs:
        teleported.median === null
          ? null
          : Math.round(((teleported.median * 1000) / WALK_SPEED) * 10) / 10,
      /**
       * One engine frame in wall milliseconds: CS2's 64 ticks a second, run
       * `host_timescale` times as fast. A timer fires on the first frame at
       * or after its due time, so this is the tolerance a period is held to.
       */
      frameMs: Math.round((1000 / (64 * (TIMESCALE ?? 1))) * 10) / 10,
      accepted: asked?.status ?? null,
      engine,
      teleported,
      /**
       * When each window ran, so what the *rest* of the match did during it
       * can be counted afterwards off the durable log — a body that stopped
       * killing anybody while it was being teleported is the second half of
       * this spike's answer, and a gap in a death timeline is only evidence
       * if the window it sits in is written down.
       */
      window: {
        engine: [new Date(engineFrom).toISOString(), new Date(engineTo).toISOString()],
        teleported: [new Date(walkedFrom).toISOString(), new Date(walkedTo).toISOString()],
      },
      console: lines,
    }
  }
  /**
   * The core plugin's `skins:` console lines (PRD-02 T28): every loadout handed to
   * the skins layer and every profile it was told to re-read, off the same console
   * buffer the scoreboard line comes from. Null rather than a failure at every step.
   */
  const readSkins = async id => {
    try {
      const rows = await api('GET', '/v1/fleet/servers')
      const row = rows.servers.find(server => server.matchId === id)
      if (!row) return null
      const tail = await api('GET', `/v1/fleet/servers/${row.id}/console`)
      const lines = tail.lines
        .map(entry => entry.line.trim())
        .filter(line => line.includes('skins:'))
      return { lines: lines.length, last: lines.at(-1) ?? null }
    } catch (error) {
      return { lines: 0, last: `unreadable: ${error.message}` }
    }
  }
  /**
   * **One command, and what finally became of it.**
   *
   * `POST /v1/matches/:id/commands` answers `applied` or `rejected` only when
   * the orchestrator settles the command itself; anything relayed to a server
   * comes back `accepted` and the real answer arrives on the stream as a
   * `command_result` frame with the same `correlationId` (`docs/match-api.md`).
   * A run that read the acknowledgement and stopped there would record
   * "accepted" for a command the plugin refused, so this waits for the late
   * answer and returns that.
   */
  /** Whether the durable log carries a fact of this type yet. It reads the whole log, which is short while a match is live. */
  const said = async type => {
    for (let cursor = '0'; cursor !== null; ) {
      const page = await api('GET', `/v1/matches/${matchId}/events?cursor=${cursor}&limit=200`)
      if (page.items.some(envelope => envelope.payload.type === type)) return true
      if (page.items.length === 0) return false
      cursor = page.nextCursor
    }
    return false
  }
  /** Who the durable log says did this, by SteamID64 (`player_ready`, `player_connected`). */
  const saidBy = async type => {
    const who = new Set()
    for (let cursor = '0'; cursor !== null; ) {
      const page = await api('GET', `/v1/matches/${matchId}/events?cursor=${cursor}&limit=200`)
      for (const envelope of page.items)
        if (envelope.payload.type === type && envelope.payload.player?.steamId64)
          who.add(envelope.payload.player.steamId64)
      if (page.items.length === 0) break
      cursor = page.nextCursor
    }
    return who
  }
  /** How many facts of this type the durable log holds right now (`--stand-in` reads the room before it adds to it). */
  const countSaid = async type => {
    let count = 0
    for (let cursor = '0'; cursor !== null; ) {
      const page = await api('GET', `/v1/matches/${matchId}/events?cursor=${cursor}&limit=200`)
      count += page.items.filter(envelope => envelope.payload.type === type).length
      if (page.items.length === 0) break
      cursor = page.nextCursor
    }
    return count
  }
  const command = async (body, waitMs = 10_000) => {
    let ack
    try {
      ack = await api('POST', `/v1/matches/${matchId}/commands`, body)
    } catch (error) {
      return { status: 'failed', message: error.message }
    }
    if (ack?.status !== 'accepted') return ack
    const until = wall.now() + waitMs
    while (wall.now() < until) {
      const late = streamFrames.find(
        frame =>
          frame.type === 'command_result' && frame.result?.correlationId === body.correlationId,
      )
      if (late) return late.result
      await wall.sleep(500)
    }
    return { ...ack, answer: 'nothing came back on the stream' }
  }
  /**
   * **`--widget`: the path only a finger had ever taken** (PRD-03 T8).
   *
   * Called once, the first poll after the match is live. It mints a player
   * token for the first rostered puppet, opens the widget socket as that
   * player's phone, claims a power-up, and leaves a listener on the socket
   * that taps again the instant that puppet dies — the corpse hunt, whose
   * whole difficulty is that the engine respawns a body in this mode as fast
   * as it can and the refusal is only true in between. Then it does the same
   * as somebody the request never rostered.
   *
   * Nothing here is typed at the server and nothing goes through
   * `/v1/matches/:id/commands`: a tap is the widget socket's own frame, which
   * is the point — `commands.rcon` stays zero for this case like every other.
   */
  const tapThePhone = async () => {
    const rostered = String(PUPPET_STEAM_ID_BASE)
    const minted = await api('POST', `/v1/matches/${matchId}/player-tokens`, {
      steamId64: rostered,
      ttlSeconds: 900,
    })
    say(`player token for ${rostered}, good until ${minted.expiresAt}`)
    const phone = await openPhone(minted.token, 'puppet')
    cleanups.push(() => phone.close())
    const record = {
      steamId64: rostered,
      expiresAt: minted.expiresAt,
      /** The `hello` back, minus nothing: it carries no secret. */
      welcome: {
        matchId: phone.welcome.matchId,
        steamId64: phone.welcome.steamId64,
        gamemode: phone.welcome.gamemode,
        state: phone.welcome.state,
        locale: phone.welcome.locale ?? null,
        commands: (phone.welcome.commands ?? []).map(verb => ({
          name: verb.name,
          chargesLeft: verb.chargesLeft,
          readyInMs: verb.readyInMs,
        })),
      },
      grant: null,
      /** Every grant tap in order: more than one only when an earlier one met a corpse. */
      grantTaps: [],
      /** `plugin_event`s named by the mode that reached this phone as `event` frames. */
      claimed: 0,
      /** `push` frames the mode sent this phone and nobody else (PRD-02 T26). */
      pushes: 0,
      /** Every tap fired at a corpse, in order, with how long after the death it was answered. */
      corpseTaps: [],
      /** The first one refused `not_alive`, which is the assertion. */
      corpse: null,
      deaths: 0,
      stranger: null,
    }
    // Everything the phone hears: the pushes the peek sends back, the mode's
    // `plugin_event` for the claim — armed **before** the grant, so what it
    // counts is the phone seeing its own tap land, which is what a widget
    // subscribing to the hub is for — and the deaths that are the corpse
    // hunt's trigger, which are only interesting once the grant has been
    // asked for and refused a second time.
    let tapping = false
    phone.on(frame => {
      if (frame.type === 'push') {
        record.pushes += 1
        return
      }
      if (frame.type !== 'event') return
      const payload = frame.envelope?.payload
      if (payload?.type === 'plugin_event' && payload.name === WIDGET_CLAIMED) {
        record.claimed += 1
        return
      }
      if (payload?.type !== 'player_death' || payload.victim?.steamId64 !== rostered) return
      if (record.grant === null) return
      record.deaths += 1
      // **Fired from the frame, not from a poll.** A dead puppet in a
      // deathmatch is dead for as long as the engine takes to respawn it, and
      // the only way to be inside that is to send the tap on the death's own
      // event rather than on the next five-second tick. One at a time, so the
      // socket's rate limiter never sees a burst.
      if (tapping || record.corpse !== null) return
      tapping = true
      const diedAt = wall.now()
      void phone
        .tap(WIDGET_VERB, { kind: WIDGET_KIND })
        .then(answer => {
          record.corpseTaps.push({
            afterMs: wall.now() - diedAt,
            status: answer.status,
            code: answer.code ?? null,
          })
          if (answer.code === 'not_alive') {
            record.corpse = answer
            say(`tapped a corpse ${wall.now() - diedAt} ms after it died: not_alive`)
          }
        })
        .finally(() => {
          tapping = false
        })
    })
    // **The grant.** The SDK checks the verb, the args, the cooldown and the
    // charge against the manifest before `powerup-dm` sees it; what comes back
    // is the mode's own answer, in this player's language.
    //
    // **The grant is aimed at a living body.** A puppet in this mode dies every
    // few seconds, so a tap fired at any moment can land between a death and a
    // respawn and be refused `not_alive`. That refusal is correct, and it is the
    // corpse case's assertion, not this one's. The second `verify:extended` of
    // the T18 sweep met exactly that and read it as "the tap did not apply".
    // So a `not_alive` grant waits a beat and asks again. Every try is recorded,
    // and the last answer stands if the body never came back.
    for (let tries = 1; ; tries += 1) {
      const answer = await phone.tap(WIDGET_VERB, { kind: WIDGET_KIND })
      record.grantTaps.push({ status: answer.status, code: answer.code ?? null })
      if (answer.code !== 'not_alive' || tries === WIDGET_GRANT_TRIES) {
        record.grant = answer
        break
      }
      say(`the grant met a corpse (try ${tries}), asking again in ${WIDGET_GRANT_RETRY_MS} ms`)
      await wall.sleep(WIDGET_GRANT_RETRY_MS)
    }
    say(`tap ${WIDGET_VERB}/${WIDGET_KIND}: ${stringify(record.grant).replace(/\s+/g, ' ')}`)
    // **The stranger.** `powerup-dm` opens its roster, so a token is minted
    // for anybody — that is the "unless the mode is open-join" half a run on
    // this mode can prove, and the closed half is the pug's, refused at the
    // door (`player_not_in_match`) and pinned against the fake. The tap is
    // then the SDK's to refuse: no body on the server answers for that id.
    let stranger = null
    try {
      const token = await api('POST', `/v1/matches/${matchId}/player-tokens`, {
        steamId64: WIDGET_STRANGER,
        ttlSeconds: 900,
      })
      const other = await openPhone(token.token, 'stranger')
      cleanups.push(() => other.close())
      stranger = {
        minted: 'ok',
        steamId64: WIDGET_STRANGER,
        welcome: { state: other.welcome.state, steamId64: other.welcome.steamId64 },
        result: await other.tap(WIDGET_VERB, { kind: WIDGET_KIND }),
      }
    } catch (error) {
      stranger = { minted: `refused: ${error.message}`, steamId64: WIDGET_STRANGER, result: null }
    }
    record.stranger = stranger
    say(`the stranger: ${stringify(stranger).replace(/\s+/g, ' ')}`)
    return record
  }
  let emptied = false
  let filled = false
  let polls = 0
  /** What `--pause` did, for the summary: every answer the pause got, and the unpause's. */
  let paused = null
  /** What `--restore` did: every answer the restore got, and the unpause that let the rewound round play. */
  let rewind = null
  /**
   * What `--drop-puppet` did: the kick the Match API answered, and whether the
   * room emptied by one and filled back up. Read off `presence` frames, which
   * is the only record of the room there is — RCON *runs* a command and does
   * not answer one (`status` over the fleet route comes back with an empty
   * `output`, measured here), and `GET /v1/fleet/servers/:id/console` carries
   * the **core plugin's** lines and not the engine's or MatchZy's. Simulation
   * mode's own mapping log is not readable from outside the box at all, which
   * is exactly why T7a reads it from inside one.
   */
  let dropped = null
  let droppedAt = 0
  let standIn = null
  /** `--hold`: when the last puppet's `player_ready` was first seen, and what the room looked like when the run gave up on the person (PRD-04 T2b). */
  let gateHeldSince = 0
  let held = null
  /** What `--widget` did: three taps and everything that came back (T8). */
  let widget = null
  /** What `--walk` measured: the same bodies moved by the engine and by a teleport (T12). */
  let walked = null
  let rated = false
  let ratedAt = 0
  let scoreboard = null
  /** The profiles the rating path pushed, and what three reads in one round made of them (PRD-04 T6). */
  let ratedProfiles = []
  let ratingProbe = null
  let skins = null
  let warmupEnded = false
  let started = false
  let liveAt = 0
  let forced = false
  let last = match.state
  let final = match
  const deadline = startedAt + TIMEOUT_MS
  while (wall.now() < deadline) {
    await wall.sleep(5_000)
    const now = await api('GET', `/v1/matches/${matchId}`)
    final = now
    if (now.state !== last) {
      say(
        `${last} → ${now.state}${now.connect ? ` (${now.connect.host}:${now.connect.port})` : ''}`,
      )
      last = now.state
    }
    if (TERMINAL.includes(now.state)) break
    if (now.state === 'live' && liveAt === 0) liveAt = wall.now()
    if (!forced && liveAt > 0 && wall.now() - liveAt >= MAX_LIVE_MS) {
      forced = true
      say(`still live after ${MAX_LIVE_MS / 60_000} minutes: ending it`)
      await api('POST', `/v1/matches/${matchId}/commands`, {
        correlationId: `${RUN_ID}-force-end`,
        type: 'force_end',
        reason: `still live after ${MAX_LIVE_MS / 60_000} minutes`,
      })
      continue
    }
    if (now.state !== 'ready' && now.state !== 'live') continue

    // **The movement spike** (PRD-03 T12), once, on a live match: whatever the
    // mode was going to do with these bodies it is doing by now, so the engine
    // window is the engine at its most honest. It holds the poll loop for
    // about half a minute, which is what a measurement costs.
    if (WALK_SECONDS > 0 && walked === null && now.state === 'live') {
      walked = await measureWalk(matchId)
      continue
    }

    // **A puppet leaves by the front door** (PRD-03 T7, T7a). Every puppet is
    // announced like a person now — the SDK's own for the modes it seats
    // (T7), and MatchZy's, cast from simulation mode's console lines, for a
    // `matchzy` flow (T7a) — so the orchestrator's presence map holds them and
    // a `kick` for the **rostered** SteamID, the only id a client ever has,
    // reaches the body that plays it. No RCON and no synthetic id, whatever
    // the flow. The room is read off the `presence` frame, every one of them
    // since the kick and in order, because a seat is refilled faster than this
    // loop polls: the player is seen gone, then seen back, and the second
    // `player_connected` for the same SteamID is in the durable log for the
    // summary to count.
    if (DROP_PUPPET && (dropped === null || dropped.back === null)) {
      let rooms = streamFrames.filter(frame => frame.type === 'presence')
      if (dropped === null) {
        // **Waited for on the stream, not on the next poll.** The window this
        // case needs is the warmup, and under simulation it is seconds wide:
        // the fork maps its bots onto the roster (which is what puts them in
        // the presence map at all), readies each about two seconds later and
        // counts down five. A five-second poll walks straight past it and
        // kicks a puppet out of a match that is already live, where the fork's
        // reconcile pass no longer runs (`isMatchSetup && readyAvailable &&
        // !matchStarted`) and nothing puts the body back. Measured: a first cut
        // of this dropped at `state: live` and the room never filled again.
        const until = wall.now() + ROOM_PATIENCE_MS
        while (wall.now() < until && (rooms.at(-1)?.players ?? []).length < BOTS) {
          await wall.sleep(250)
          rooms = streamFrames.filter(frame => frame.type === 'presence')
        }
        if ((rooms.at(-1)?.players ?? []).length < BOTS) {
          die(
            `no room of ${BOTS} in the presence map after ${ROOM_PATIENCE_MS / 1000} s: nothing announced the puppets`,
          )
        }
        const rostered = String(PUPPET_STEAM_ID_BASE)
        const frontDoor = await command({
          correlationId: `${RUN_ID}-kick-rostered`,
          type: 'kick',
          steamId64: rostered,
          reason: 'the lane is taking one puppet off the server',
        })
        say(`kick ${rostered} (the rostered id): ${stringify(frontDoor).replace(/\s+/g, ' ')}`)
        droppedAt = wall.now()
        dropped = {
          rostered,
          state: (await api('GET', `/v1/matches/${matchId}`)).state,
          standing: BOTS,
          frontDoor,
          stimulus: 'kick',
          left: null,
          back: null,
          roomsBefore: rooms.length,
        }
        continue
      }
      for (const room of rooms.slice(dropped.roomsBefore)) {
        const here = room.players.some(player => player.steamId64 === dropped.rostered)
        if (dropped.left === null && !here) {
          dropped.left = { afterMs: wall.now() - droppedAt, standing: room.players.length }
          say(`the room is ${room.players.length}: ${dropped.rostered} left by the front door`)
        } else if (dropped.left !== null && dropped.back === null && here) {
          dropped.back = { afterMs: wall.now() - droppedAt, standing: room.players.length }
          say(`the room is ${room.players.length} again: ${dropped.rostered} is back`)
        }
      }
    }

    // **EZ Rating on the scoreboard** (PRD-02 T27), on real hardware, without a
    // human: a bot has no Steam account but it does have a SteamID64 the whole
    // tree agrees on (`BotIdentity`, slot + 90000000000000000), so the platform
    // can push a `profile` for one exactly as it would for a person who joined
    // open. Only for a gamemode whose manifest asks for the number *and* opens
    // its roster — anywhere else the push is refused, correctly, and there is
    // nothing to see. One poll's grace first, so the bots the loader asked for
    // are standing when the profiles land.
    if (RATED && !rated && polls++ > 0) {
      rated = true
      ratedAt = polls
      // **Whose scoreboard is being written on** (PRD-03 T10). Without
      // `--simulate` the bodies are anonymous bots and their ids are
      // `BotIdentity`'s. With it they are **puppets**, and a puppet carries the
      // roster's SteamID — so the bot identities are ids nobody on that server
      // answers for, and three profiles pushed at them were accepted by the
      // door (a `profile` is not gated on presence: the platform may push one
      // ahead of the person) and reached nobody. Measured on the first retakes
      // row: `scoreboard: 1 rated: SourceTV 1000`, three puppets and not a
      // number among them.
      const profiles = PUPPETS
        ? [...PUPPETS.teamA, ...PUPPETS.teamB].map(entry => ({
            steamId64: entry.steamId64,
            name: entry.name,
            locale: entry.locale,
          }))
        : Array.from({ length: Math.max(BOTS, 2) }, (_, slot) => ({
            steamId64: String(BOT_STEAM_ID_BASE + BigInt(slot)),
            name: `EZ Bot ${slot}`,
            locale: slot % 2 === 0 ? 'de' : 'en',
          }))
      ratedProfiles = profiles
      for (const [index, who] of profiles.entries()) {
        await api('POST', `/v1/matches/${matchId}/commands`, {
          correlationId: `${RUN_ID}-profile-${index}`,
          type: 'profile',
          player: {
            ...who,
            rating: 1000 + index * 111,
            rankName: 'Iron',
            // The loadout travels with the profile the way it would for a person who
            // joined open (T28); the core says `skins:` for each one it is handed.
            ...(SKINNED && { loadout: LOADOUT }),
          },
        })
      }
      say(
        `pushed ${profiles.length} ${PUPPETS ? 'puppet' : 'bot'} profiles${SKINNED ? ' with loadouts' : ''}`,
      )
      continue
    }

    // …and read the numbers back a few polls later, off the controllers rather
    // than off what was asked for. Later on purpose: the only honest moment to
    // look is once the match is standing and everybody has spawned at least
    // once (measured — read at `ready`, only the players who had already
    // spawned were rated at all). What a puppet is rated *with* is always `0`:
    // a bot controller keeps the rank type and never the number (PRD-04 T6,
    // `docs/gamemodes.md`), which is why the probe below reads three times.
    if (rated && scoreboard === null && polls++ > ratedAt + 3) {
      scoreboard = await readScoreboard(matchId)
      say(`scoreboard: ${scoreboard ?? 'not readable'}`)
      if (SKINNED) {
        skins = await readSkins(matchId)
        say(
          `skins: ${skins ? `${skins.lines} console lines, last: ${skins.last}` : 'not readable'}`,
        )
      }
    }

    // …and once more, three times inside one live round (PRD-04 T6): only a
    // live match has rounds to start, and the probe waits for the next one.
    if (scoreboard !== null && ratingProbe === null && now.state === 'live') {
      ratingProbe = await probeRating(matchId, ratedProfiles)
      continue
    }

    // **Everything from here to `mp_warmup_end` is the escape hatch**
    // (`--force-start`, PRD-03 T5): four RCON commands that start a match
    // nobody is rostered on. A puppet run takes none of them, and no green run
    // depends on them.
    //
    // **The bots arrive after the match goes live, not before it** — and that
    // order is the whole reason this box records a demo at all (PRD-02 T21a).
    //
    // Two engine facts decide it, both measured on this box against CS2
    // 1.41.7.8 with one command per boot:
    //
    //  - The GOTV client counts as one of the bots the engine may evict. Under
    //    `bot_quota_mode normal` (and `fill`), a `bot_quota` that *drops* while
    //    bots are standing takes SourceTV with it — and MatchZy's `live.cfg`
    //    opens with exactly that drop. A drop with nothing to drop is a
    //    no-change, fires no callback and evicts nobody; so is every *rise*.
    //  - Bots under `bot_quota_mode competitive` — the mode
    //    `gamemode_competitive.cfg` sets at every map load, and the one mode
    //    whose purge does spare GOTV — do not fight. Ten of them played seven
    //    rounds with zero kills and zero damage between them, every round to
    //    the CT side on the clock, so the map cannot be decided and no
    //    `series_end` ever comes. `normal` bots play properly.
    //
    // So `gamemodes/pug/cfg/ezpug/pug.cfg` puts the server in `normal` while
    // the quota is zero, this empties the server *before* `css_start` so
    // `live.cfg`'s drop is a no-op, and the bots are asked for once the match
    // is live and the only way left is up.
    //
    // The cost is that `live.cfg`'s own `mp_warmup_end` runs on an empty server
    // and ends nothing, so the warmup is ended here instead, a poll after the
    // bots are in. A `mp_warmup_end` outside warmup does nothing, which is what
    // makes it safe to send unconditionally.
    if (now.state === 'ready') {
      // **The person's seat under MatchZy is held at the gate** (PRD-04 T2b,
      // {@link HOLD}). The row waits for every puppet's `player_ready`, holds
      // the room past the moment an unpatched fork would have force-started
      // it, reads what the log says went live meanwhile (nothing may have),
      // and cancels: the next poll sees `cancelled` and the run ends there.
      if (HOLD && held === null) {
        const ready = await saidBy('player_ready')
        const puppetsReady = PUPPET_STEAM_IDS.filter(steamId64 => ready.has(steamId64)).length
        if (puppetsReady < PUPPET_STEAM_IDS.length) continue
        if (gateHeldSince === 0) {
          gateHeldSince = wall.now()
          say(
            `all ${puppetsReady} puppets ready; holding ${GATE_HOLD_MS / 1_000} s for the person, past the fork's watchdog`,
          )
          continue
        }
        if (wall.now() - gateHeldSince < GATE_HOLD_MS) continue
        const atMs = wall.now()
        held = {
          at: new Date(atMs).toISOString(),
          puppetsReady,
          heldMs: atMs - gateHeldSince,
          stateBefore: now.state,
          liveBefore: await countSaid('going_live'),
        }
        say(
          `held ${Math.round(held.heldMs / 1_000)} s with nobody in the person's seat and ${held.liveBefore} going_live; calling it off`,
        )
        await api('POST', `/v1/matches/${matchId}/cancel`)
        continue
      }
      // A mode whose flow is nobody's plugin starts itself and fills itself: the
      // loader set the request's `bot_quota` a beat after the mode's cfg (T22a),
      // so the bots are already standing, and the SDK's generic emitter ends the
      // warmup twenty seconds after the map is up with `going_live` the round
      // after (PRD-02 T22). Nothing to force and nothing to empty — `live.cfg` is
      // MatchZy's file and no other flow has one — so there is nothing to do here
      // at all, which is the shape a client should have.
      if (FLOW !== 'matchzy') continue
      // **And a `matchzy` match of puppets has nothing to do here either**
      // (PRD-03 T5). Simulation mode clears the base configs' bots, spawns one
      // of its own per roster entry, readies each of them and ends the warmup
      // from `CheckLiveRequired` — through the front door, every step. All
      // four commands below are the escape hatch, and it is taken only when a
      // run asked for it by name.
      if (!FORCE_START) continue
      if (BOTS > 0 && !emptied) {
        emptied = true
        say('emptying the server before the start, so `live.cfg` cannot take GOTV with it')
        await rcon('bot_kick; bot_quota 0', 'empty')
        continue
      }
      if (!started) {
        started = true
        say('forcing the start (`css_start`): a bot never readies up')
        await rcon('css_start', 'start')
      }
      continue
    }

    // **A stand-in for the person who never came** (PRD-04 T2): once the
    // match is live and the puppeteer has long finished seating, one plain
    // bot per empty chair over RCON — the row's one typed command, declared.
    // Nothing is asserted about the bot beyond that it is furniture: the
    // summary reads the durable log for whether the person's SteamID was ever
    // announced, and it must not have been.
    if (STAND_IN && standIn === null && liveAt > 0 && wall.now() - liveAt >= STAND_IN_AFTER_MS) {
      const connectedBefore = await countSaid('player_connected')
      const answer = await rcon(
        Array.from({ length: HUMANS }, () => 'bot_add').join('; '),
        'stand-in',
      )
      standIn = {
        at: new Date(wall.now()).toISOString(),
        status: answer.status ?? null,
        connectedBefore,
      }
      say(
        `stood in for ${HUMANS} person(s) with a plain bot each (${answer.status ?? 'no status'})`,
      )
      continue
    }

    // Live, and a phone in a puppet's hand (PRD-03 T8). As early as the match
    // allows: a tap is refused `not_live` before this point, and the corpse
    // hunt wants as many of this puppet's deaths as the match has left.
    if (WIDGET && widget === null) {
      widget = await tapThePhone()
      continue
    }

    // Live. **Pause and unpause, through the front door** (PRD-03 T6): two
    // match commands two polls apart, which is the path the platform's admin
    // console takes and the only one a client has. The facts are the core
    // plugin's — MatchZy's own pause events are dropped at the door because
    // the plugin already says it (T3) — so this is where that decision meets
    // hardware.
    //
    // **A pause that says no** (PRD-04 T4). MatchZy refuses `css_forcepause`
    // during halftime, and a 1v1 at four regulation rounds reaches halftime
    // about when this fires. The core plugin used to answer `applied` anyway,
    // so the row asked again on a timer and hoped (OPEN-POINTS §6, closed).
    // Now the refusal is the answer — `invalid_state`, the reason word first —
    // so the row asks again *because it was told no*, records the word every
    // try came back with, and stops on the first answer that is not a refusal.
    // Whether a run meets halftime at all is the map's business, so the
    // refusal this row is *sure* of is asked for below, after the unpause.
    if (PAUSE && paused === null && liveAt > 0 && wall.now() - liveAt >= 20_000) {
      paused = { pause: null, unpause: null, again: null, tries: [], held: false }
      const until = wall.now() + PAUSE_WINDOW_MS
      while (!paused.held && wall.now() < until) {
        const suffix = paused.tries.length === 0 ? '' : `-${paused.tries.length + 1}`
        const answer = await command({ correlationId: `${RUN_ID}-pause${suffix}`, type: 'pause' })
        paused.tries.push({
          at: new Date(wall.now()).toISOString(),
          status: answer?.status ?? null,
          code: answer?.code ?? null,
          // The word alone: the sentence after it is for a human and may change.
          reason: (answer?.message ?? '').split(':')[0] || null,
        })
        paused.pause = answer
        if (answer?.status !== 'rejected') break
        say(`pause ${paused.tries.length} refused (${paused.tries.at(-1).reason}), asking again`)
        await wall.sleep(PAUSE_GAP_MS)
      }
      // The answer is the server's, so `applied` is believed — the fact is only
      // read back to prove the two agree. It is given a moment: the plugin
      // emits it before it answers, but the fact travels the link, the log and
      // the replay route while the answer comes straight back down the call.
      if (paused.pause?.status === 'applied') {
        const factBy = wall.now() + PAUSE_FACT_MS
        while (!paused.held && wall.now() < factBy) {
          paused.held = await said('match_paused')
          if (!paused.held) await wall.sleep(1_000)
        }
      }
      say(paused.held ? `paused (try ${paused.tries.length})` : 'the pause never held')
      continue
    }
    // Live, three rounds in. **A rewind through the front door** (PRD-04 T8):
    // one `restore` to round 2, asked again only while the refusal is one
    // that passes (halftime), then MatchZy's own pause after a restore lifted
    // the way an admin would. What round 2 looked like the first time and
    // the second is read off the durable log in the summary.
    //
    // **Asked in the gap after a round, on purpose.** Asked mid-round, the
    // engine ends the round and restarts it from the file at once; asked
    // after a round has ended, MatchZy accepts and the engine loads the file
    // and never restarts — the dev node's second and fourth runs sat in
    // `RoundOver` until they were force-ended. The plugin refuses that gap
    // up front (`round_over`), so the row waits on the live stream for the
    // third `round_end`, asks the moment it arrives, is told no in so many
    // words, and asks again once the next round is under way.
    if (
      RESTORE &&
      rewind === null &&
      liveAt > 0 &&
      (await countSaid('round_end')) >= RESTORE_AFTER_ROUNDS - 1
    ) {
      const ended = () =>
        streamFrames.filter(
          frame => frame.type === 'event' && frame.envelope.payload.type === 'round_end',
        ).length
      const roundBy = wall.now() + RESTORE_ROUND_WAIT_MS
      while (ended() < RESTORE_AFTER_ROUNDS && wall.now() < roundBy) await wall.sleep(100)
      rewind = {
        round: RESTORE_ROUND,
        tries: [],
        restore: null,
        at: null,
        pausedAfter: false,
        unpause: null,
      }
      const until = wall.now() + RESTORE_WINDOW_MS
      const pausesBefore = await countSaid('match_paused')
      while (wall.now() < until) {
        const suffix = rewind.tries.length === 0 ? '' : `-${rewind.tries.length + 1}`
        const answer = await command(
          {
            correlationId: `${RUN_ID}-restore${suffix}`,
            type: 'restore',
            roundNumber: RESTORE_ROUND,
          },
          20_000,
        )
        rewind.tries.push({
          at: new Date(wall.now()).toISOString(),
          status: answer?.status ?? null,
          code: answer?.code ?? null,
          reason: (answer?.message ?? '').split(':')[0] || null,
        })
        rewind.restore = answer
        if (answer?.status !== 'rejected' || answer.code !== 'invalid_state') break
        if (!['round_over', 'halftime', 'timeout_active'].includes(rewind.tries.at(-1).reason))
          break
        say(`restore ${rewind.tries.length} refused (${rewind.tries.at(-1).reason}), asking again`)
        await wall.sleep(PAUSE_GAP_MS)
      }
      rewind.at = new Date(wall.now()).toISOString()
      say(`restore to round ${RESTORE_ROUND}: ${rewind.restore?.status ?? 'no status'}`)
      // MatchZy pauses a round it restored, and only one it restored — so a
      // pause after the ask is lifted whatever the answer said: a refusal
      // with a pause behind it is a run worth reading to the end, and the
      // rewound round shows only once the pause is gone.
      const pauseBy = wall.now() + RESTORE_PAUSE_MS
      while (wall.now() < pauseBy && (await countSaid('match_paused')) <= pausesBefore)
        await wall.sleep(1_000)
      rewind.pausedAfter = (await countSaid('match_paused')) > pausesBefore
      if (rewind.pausedAfter) {
        rewind.unpause = await command({
          correlationId: `${RUN_ID}-restore-unpause`,
          type: 'unpause',
        })
        say(`lifted MatchZy's pause after the restore (${rewind.unpause?.status ?? 'no status'})`)
      }
      continue
    }
    if (paused !== null && paused.unpause === null) {
      await wall.sleep(5_000)
      paused.unpause = await command({ correlationId: `${RUN_ID}-unpause`, type: 'unpause' })
      say(`unpaused (${paused.unpause?.status ?? 'no status'})`)
      // **And once more, into a match that is running** (PRD-04 T4). The
      // halftime refusal is the one the field found, but whether a run meets
      // halftime is luck; this one is not. An `unpause` for a match nobody
      // paused has exactly one right answer, so every run of this row watches
      // a refusal come back as a refusal, with the word in front of it.
      paused.again = await command({ correlationId: `${RUN_ID}-unpause-again`, type: 'unpause' })
      say(`asked again for an unpause nobody needed (${paused.again?.status ?? 'no status'})`)
      continue
    }
    // The bots, then the warmup, one poll apart — MatchZy's order, and
    // only its. Another flow already had both before it went live, and a
    // puppet match had them from its own simulation mode.
    if (FLOW !== 'matchzy' || !FORCE_START) continue
    if (BOTS > 0 && !filled) {
      filled = true
      say(`filling the server with ${BOTS} bots`)
      await rcon(`bot_quota ${BOTS}`, 'bots')
      continue
    }
    if (BOTS > 0 && !warmupEnded) {
      warmupEnded = true
      await rcon('mp_warmup_end', 'warmup-end')
    }
  }
  if (!TERMINAL.includes(final.state)) say(`gave up after ${TIMEOUT_MS / 60_000} minutes`)

  // 7. Let the last envelopes land, then read everything back the way a client
  //    that missed a webhook would.
  await wall.sleep(5_000)
  // Every page: the route is a replay of the whole durable log and the last
  // page is where `match.ended` lives.
  //
  // **An empty page is the end, whatever the cursor says.** The route only
  // returns a null `nextCursor` once the reader has caught up *and the match
  // is terminal* (`machine.ts`) — deliberately, so a client can tail a live
  // match — so a run that gave up on a match still playing would otherwise
  // spin on the same cursor at full speed until the rate limiter stopped it.
  const envelopes = []
  for (let cursor = '0'; cursor !== null; ) {
    const page = await api('GET', `/v1/matches/${matchId}/events?cursor=${cursor}&limit=200`)
    if (page.items.length === 0) break
    envelopes.push(...page.items)
    cursor = page.nextCursor
  }
  const ledger = await api('GET', `/v1/fleet/ledger?since=${new Date(startedAt).toISOString()}`)
  const fleet = await api('GET', '/v1/fleet/servers')

  // **The bytes, read back off the store rather than off the report.**
  // `match.ended` carries what the plugin believed about its own upload and
  // the relay carries what arrived at this box; neither is the object. A
  // signed HEAD against the real endpoint is — and it goes to `s3.endpoint`,
  // loopback, because that is where the object is and the relay is a door for
  // somebody else.
  let demoStored = null
  if (s3) {
    try {
      const head = await fetch(
        presignPut({
          ...s3,
          key: demoKey,
          method: 'HEAD',
          expiresIn: 600,
          now: wall.at(),
        }),
        { method: 'HEAD' },
      )
      demoStored = head.ok
        ? { found: true, bytes: Number(head.headers.get('content-length') ?? 0) }
        : { found: false, status: head.status }
      // And the first bytes of it (PRD-04 T11): a length says something arrived, the
      // magic says it is a CS2 demo — `PBDEMS2\0`, the header every Source 2 `.dem`
      // opens with — and not an empty PUT or a proxy's error page.
      if (demoStored.found) {
        const first = await fetch(
          presignPut({ ...s3, key: demoKey, method: 'GET', expiresIn: 600, now: wall.at() }),
          { headers: { range: 'bytes=0-7' } },
        )
        const bytes = first.ok ? Buffer.from(await first.arrayBuffer()).subarray(0, 8) : null
        demoStored.magic = bytes ? bytes.toString('latin1').replace(/\0/g, '\\0') : null
      }
    } catch (error) {
      demoStored = { found: false, error: error.message }
    }
    say(
      demoStored.found
        ? `demo in the store: ${demoStored.bytes} bytes at ${s3.bucket}/${demoKey}, opening ${JSON.stringify(demoStored.magic)}`
        : `demo not in the store (${demoStored.status ?? demoStored.error})`,
    )
  }

  return {
    run: RUN_ID,
    forced,
    matchId,
    flow: FLOW,
    request,
    match: final,
    envelopes,
    ledger,
    fleet,
    deliveries,
    streamFrames,
    trace: readTrace(traceFrom),
    startedAt,
    lock: lane
      ? {
          taken: true,
          path: lane.path,
          waitedSeconds: Math.round(lane.waitedMs / 1_000),
          /** The corpse this run stepped over, if it did — never a live holder. */
          broke: lane.broke ? describeLaneLock(lane.broke) : null,
        }
      : { taken: false, path: null, waitedSeconds: 0, broke: null },
    demoTarget: s3 ? `${s3.endpoint}/${s3.bucket}/${demoKey}` : null,
    demoStored,
    demoRelay: demoRelay?.seen ?? null,
    scoreboard,
    ratingProbe,
    skins,
    paused,
    rewind,
    dropped,
    standIn,
    held,
    humans: HUMAN_STEAM_IDS,
    widget,
    walked,
  }
}

// ---------------------------------------------------------------------------
// Writing it down
// ---------------------------------------------------------------------------

/**
 * The link exchange, **without the ephemeral tier**. `position_tick` is
 * stream-only by decision 6 — never stored, never replayed — so a file in the
 * tree that held one would be storing it, and a five-minute match's ticks are
 * nine tenths of the bytes and none of the meaning. The `ack` a tick-only
 * batch earned goes with it, or the recording would acknowledge frames it
 * does not contain.
 */
/**
 * **Round 2, twice** (PRD-04 T8): what `--restore` asked and was answered,
 * with the log's own account of it — the round's two `round_start`s, the
 * `backup_restored` the plugin said, and the rounds that ended after the
 * second start, in order. The two starts are found by round number and not
 * by where `backup_restored` sits: that fact comes over the link and the
 * start over MatchZy's remote log, and on the dev node the start won.
 */
function rewoundRounds(rewind, envelopes) {
  const facts = envelopes.map(envelope => envelope.payload)
  const start = payload =>
    payload ? { roundNumber: payload.roundNumber, score: payload.score } : null
  const starts = facts.filter(
    payload => payload.type === 'round_start' && payload.roundNumber === rewind.round,
  )
  const again = facts.indexOf(starts[1])
  return {
    ...rewind,
    first: start(starts[0]),
    restored:
      facts.find(payload => payload.type === 'plugin_event' && payload.name === 'backup_restored')
        ?.data ?? null,
    again: start(starts[1]),
    endsAfter:
      again === -1
        ? []
        : facts
            .slice(again + 1)
            .filter(payload => payload.type === 'round_end')
            .map(payload => ({ roundNumber: payload.roundNumber, score: payload.score })),
  }
}

/** What `match.ended` said became of this match's demos, or `null` before it landed. */
function demoOutcome(envelopes) {
  return envelopes.find(envelope => envelope.payload.type === 'match.ended')?.payload.demo ?? null
}

function exchanges(trace, kind) {
  const bySocket = new Map()
  const dropped = new Set()
  for (const entry of trace) {
    if (entry.kind !== kind) continue
    let frame = entry.frame
    if (frame?.type === 'events') {
      const kept = []
      for (const sequenced of frame.events) {
        if (sequenced.event.type === 'position_tick') dropped.add(sequenced.seq)
        else kept.push(sequenced)
      }
      if (kept.length === 0) continue
      frame = { ...frame, events: kept }
    }
    if (frame?.type === 'ack' && frame.results.every(result => dropped.has(result.seq))) continue
    const list = bySocket.get(entry.socket) ?? []
    list.push(entry.close ? { from: entry.from, close: entry.close } : { from: entry.from, frame })
    bySocket.set(entry.socket, list)
  }
  return bySocket
}

function write(result) {
  mkdirSync(OUT_DIR, { recursive: true })

  const identities = {
    [result.matchId]: FIXTURE_MATCH_ID,
    [result.request.clientMatchId]: 'iron-match-recorded',
  }
  if (result.match.serverId)
    identities[result.match.serverId] =
      FIXTURE_PREFIX === 'real' ? 'devbox-1' : `${FIXTURE_PREFIX}-1`
  // MatchZy knows the match by a serial derived from its id
  // (`match-config/matchzy.ts` `matchzySerial`): scrub the id and leave the
  // serial and the two no longer agree, which is exactly what the door
  // checks. Both move together.
  const scrub = makeScrubber(
    identities,
    result.startedAt,
    new Map([[matchzySerial(result.matchId), matchzySerial(FIXTURE_MATCH_ID)]]),
  )

  const link = [...exchanges(result.trace, 'link').values()].flat()
  const node = [...exchanges(result.trace, 'node').values()].flat()
  // **The wire, and only the wire.** What MatchZy sent is evidence and never
  // changes; what the orchestrator made of it is a decision that does — the
  // expected translation lives in `apps/orchestrator/src/matchzy/fixtures/`,
  // where a test recomputes it, and duplicating it here would leave a stale
  // copy in a file nobody regenerates.
  const matchzy = result.trace
    .filter(entry => entry.kind === 'matchzy')
    .map(({ name, payload }) => ({ name, payload }))

  // The ledger row this match opened, closed or not: "a live test that leaves
  // a server running is a P1" (CLAUDE.md), so the run says so itself.
  const rows = result.ledger.items.filter(row => row.matchId === result.matchId)
  const bundle = {
    run: result.run ?? RUN_ID,
    baseUrl: BASE_URL,
    matchId: result.matchId,
    finalState: result.match.state,
    endedReason: result.match.endedReason ?? null,
    /** True when the run had to end it rather than MatchZy finishing the series. */
    forcedEnd: result.forced === true,
    /**
     * **Puppets, as the request asked and the resource answered** (PRD-03 T4,
     * T5): how many were rostered, the engine clock they played at, and
     * whether the orchestrator marked the match simulated — the field every
     * fact of this match also carries, so a consumer can never mistake it for
     * a real one. `null` when nobody was simulated.
     */
    simulation: result.request.simulation
      ? {
          /** How many roster entries a bot plays: everybody, less the people (PRD-04 T2). */
          puppets:
            result.request.teams.teamA.players.length +
            result.request.teams.teamB.players.length -
            result.humans.length,
          /** How many roster entries were left to people, and who: never announced, never cast. */
          humans: result.humans.length,
          people: result.humans.map(steamId64 => ({
            steamId64,
            announced: result.envelopes.some(
              envelope =>
                envelope.payload.type === 'player_connected' &&
                envelope.payload.player?.steamId64 === steamId64,
            ),
          })),
          /** `--stand-in`: when the plain bots were added and how many announcements the log held before. */
          standIn: result.standIn ?? null,
          /** `--hold`: the ready puppets, how long the person's seat was held, and what had gone live by then (T2b). */
          held: result.held ?? null,
          timeScale: result.request.simulation.timeScale ?? 1,
          simulated: result.match.simulated === true,
          /** The story the puppets were asked to play (PRD-03 T11), or null for "just play it". */
          scenario: result.request.simulation.scenario ?? null,
          /** Which provider actually played it — the same scenario runs on both (T11). */
          provider: result.match.provider ?? null,
        }
      : null,
    /**
     * **The shared CS2 lane, and what it cost to get onto it** (PRD-03 T13):
     * whether this run took the box's one lock, how long it queued behind the
     * other loop, and whose corpse it had to step over. `taken: false` is a
     * run that could not have landed on the container — the simulator, or a
     * rented box — and is how the lane's own test tells its two legs apart.
     */
    lock: result.lock ?? null,
    demoTarget: result.demoTarget,
    /** What `match.ended` said became of the demos (T21). */
    demo: result.match.endedReason ? (demoOutcome(result.envelopes) ?? null) : null,
    /** What a signed HEAD found at the target afterwards — the object, not the report (T36). */
    demoStored: result.demoStored ?? null,
    /** What the public relay saw, when there was one: the PUT as it crossed the internet (T36). */
    demoRelay: result.demoRelay ?? null,
    /** `ezpug_status`'s `scoreboard:` line while the match was up, or null when this gamemode does not show a rating (T27). */
    scoreboard: result.scoreboard ?? null,
    /** Three `scoreboard:` reads in one live round — at its `round_start`, mid-round, and after the same profiles were pushed again — or null when there was no rating to read or no live round to read it in (PRD-04 T6). */
    ratingProbe: result.ratingProbe ?? null,
    /** The core plugin's `skins:` console lines — how many, and the last — while the match was up, or null when no loadout was on the roster (T28). */
    skins: result.skins ?? null,
    /**
     * **What the run typed at the match, and what it did not** (PRD-03 T6).
     *
     * `rcon` counts the `rcon` commands this run sent *at the match* — the
     * escape hatch's four, and a lane case's own stimulus. It is how "no RCON
     * touched the flow" stops being a claim about the code and becomes an
     * assertion about the run: a `--simulate` match that went live with a
     * zero here went live because players readied. Reads off the fleet routes
     * (`status`, `ezpug_status`) are not in it — they ask the server a
     * question and tell it nothing.
     */
    commands: {
      rcon: calls.filter(call => call.route.endsWith('/commands') && call.request?.type === 'rcon')
        .length,
      total: calls.filter(call => call.route.endsWith('/commands')).length,
    },
    /**
     * **Every payload MatchZy POSTed, by name, with its count** — the wire
     * before the door, not after it (PRD-03 T6). `payloads` above is what
     * survived translation; this is what arrived, so the two read side by
     * side say what the door dropped and why it was right to.
     *
     * It is also the only place a puppet's *leaving* is visible: the core
     * plugin announces connections for humans only (T7 changed that outside MatchZy, T7a is what changes it here),
     * while the fork synthesises a `player_connect` and a `player_disconnect`
     * per bot, each carrying the rostered SteamID it maps to. Empty when the
     * run recorded no trace.
     */
    matchzy: Object.fromEntries(
      Object.entries(
        matchzy.reduce((counts, entry) => {
          counts[entry.name] = (counts[entry.name] ?? 0) + 1
          return counts
        }, {}),
      ).sort(([a], [b]) => (a < b ? -1 : 1)),
    ),
    /**
     * `--pause`: every answer the pause got, the unpause's, and the second
     * unpause nobody needed — or null when the run never paused (T6). A
     * refused try carries the reason word the plugin put in front of its
     * message (PRD-04 T4).
     */
    paused: result.paused ?? null,
    /**
     * `--restore` (PRD-04 T8): every answer the restore got and the unpause
     * after it, plus round 2 as the durable log tells it twice — its first
     * `round_start` and its second — the plugin's `backup_restored`, and every
     * round the map ended on after the rewind. `null` when the run never
     * rewound.
     */
    rewind: result.rewind ? rewoundRounds(result.rewind, result.envelopes) : null,
    /** `--drop-puppet`: who left, how, and whether the room filled back up (T6). */
    dropped: result.dropped ?? null,
    /**
     * **`--widget`: the phone's three taps** (PRD-03 T8) — the grant the SDK
     * applied, the corpse it refused `not_alive`, and the stranger it refused
     * `not_in_match` — plus what came back the other way: the mode's
     * `plugin_event` for the claim and the `push` frames only this phone got.
     * `null` when the run never opened a widget socket. No token is in it:
     * one was minted and the run says when it dies, which is the fact.
     */
    widget: result.widget ?? null,
    /**
     * **`--walk`: what a radar would have drawn** (PRD-03 T12). The same
     * bodies in the same match, once as the engine moves them and once on a
     * circle of a known radius at a known speed, measured off the stream's
     * position ticks — the only door a platform has to a position at all.
     * `null` when the run never walked anybody.
     */
    radar: result.walked
      ? {
          ...result.walked,
          /**
           * **What the engine went on doing while the bodies were ours.** The
           * deaths the durable log holds inside each window: a mode whose
           * story is deaths is still telling it under a teleport, or it is
           * not, and that is the difference between replaying a round's
           * movement and replaying a round.
           */
          deaths: Object.fromEntries(
            Object.entries(result.walked.window).map(([name, [from, to]]) => [
              name,
              result.envelopes.filter(
                envelope =>
                  envelope.payload.type === 'player_death' &&
                  envelope.occurredAt >= from &&
                  envelope.occurredAt <= to,
              ).length,
            ]),
          ),
        }
      : null,
    ledger: {
      rows: rows.length,
      open: rows.filter(row => row.releasedAt === null).length,
      cents: rows.reduce((total, row) => total + (row.cost?.accruedCents ?? 0), 0),
    },
    /**
     * **What a mode said in its own words**, by name, with its count: a
     * `plugin_event` is one payload type in {@link payloads} whatever it
     * carries, and `powerup_claimed` is the whole assertion of a widget tap
     * reaching the SDK (PRD-03 T8).
     */
    pluginEvents: Object.fromEntries(
      Object.entries(
        result.envelopes.reduce((counts, envelope) => {
          if (envelope.payload.type !== 'plugin_event') return counts
          counts[envelope.payload.name] = (counts[envelope.payload.name] ?? 0) + 1
          return counts
        }, {}),
      ).sort(([a], [b]) => (a < b ? -1 : 1)),
    ),
    /**
     * **How the match's length showed on the wire** (PRD-03 T9): what
     * `going_live` said was in force, and what the terminal facts said ended
     * it. All `null` for a match the game itself ended — a `pug`, a knife.
     */
    length: (() => {
      const of = type => result.envelopes.find(envelope => envelope.payload.type === type)?.payload
      return {
        inForce: of('going_live')?.length ?? null,
        mapEnd: of('map_end')?.reason ?? null,
        seriesEnd: of('series_end')?.reason ?? null,
        winner: of('series_end')?.winner ?? null,
      }
    })(),
    /** Every payload type the durable log ended up holding, with its count. */
    payloads: Object.fromEntries(
      Object.entries(
        result.envelopes.reduce((counts, envelope) => {
          counts[envelope.payload.type] = (counts[envelope.payload.type] ?? 0) + 1
          return counts
        }, {}),
      ).sort(([a], [b]) => (a < b ? -1 : 1)),
    ),
    /**
     * **The classes of fact this match produced, in order**, with a run of the
     * same class collapsed to one (PRD-03 T11). `payloads` counts; this is the
     * *shape* of the story, which is the only thing two engines as different
     * as a story builder and a CS2 server can honestly be held to. It is what
     * a scenario played on the simulator and on a real server are compared by,
     * and the diff between them is a bug in one of the two.
     */
    story: result.envelopes
      .map(envelope => envelope.payload.type)
      .filter((type, index, all) => type !== all[index - 1]),
    counts: {
      calls: calls.length,
      envelopes: result.envelopes.length,
      deliveries: result.deliveries.length,
      streamFrames: result.streamFrames.length,
      streamTicks: result.streamFrames.filter(frame => frame.type === 'tick').length,
      linkFrames: link.length,
      nodeFrames: node.length,
      matchzyPayloads: matchzy.length,
      openServersAfter: result.fleet.servers.length,
    },
  }

  // Everything the files below are derived from, unscrubbed and ephemeral
  // (`.cache/` is gitignored): a match costs eight minutes of real hardware,
  // so changing how a fixture is *shaped* must not cost another one —
  // `--rebuild <dir>` reads this back and writes the files again.
  writeFileSync(join(OUT_DIR, 'raw.json'), stringify({ ...result, calls }))
  writeFileSync(join(OUT_DIR, 'run.json'), stringify(bundle))
  writeFileSync(
    join(OUT_DIR, 'client.json'),
    stringify(
      scrub({
        flow: `${FIXTURE_PREFIX}-${GAMEMODE}-bo1`,
        calls,
        envelopes: result.envelopes,
        // The order they arrived in, that each verified, and which attempt it
        // took — the shape the conformance recordings use, so one reader
        // serves both, and the envelope itself is already in `envelopes`
        // under the same `seq`.
        deliveries: result.deliveries.map(delivery => ({
          seq: delivery.envelope.seq,
          type: delivery.envelope.payload.type,
          signature: delivery.signature,
          attempt: delivery.attempt,
        })),
        // `frames`, like the conformance recordings — minus the ephemeral
        // tier, the same rule as the link exchange.
        frames: result.streamFrames.filter(frame => frame.type !== 'tick'),
      }),
    ),
  )
  writeFileSync(
    join(OUT_DIR, 'link.json'),
    stringify(scrub({ schema: 'LinkExchange', exchange: link })),
  )
  writeFileSync(
    join(OUT_DIR, 'node.json'),
    stringify(scrub({ schema: 'NodeExchange', exchange: node })),
  )
  // Only a `matchzy` flow has a MatchZy exchange, and an empty one is not
  // evidence of anything: another flow's story crosses `/link` and is already
  // in `link.json`.
  if (matchzy.length > 0)
    writeFileSync(
      join(OUT_DIR, 'matchzy.json'),
      stringify(scrub({ schema: 'MatchZyExchange', events: matchzy })),
    )
  writeFileSync(join(OUT_DIR, 'ledger.json'), stringify(scrub(result.ledger)))
  say(`wrote the run to ${OUT_DIR}`)
  if (OUT_DIR === join(RUNS_DIR, RUN_ID)) pruneRuns()

  if (!WRITE_FIXTURES) {
    say('run again with --write-fixtures to update the recorded files')
    return bundle
  }
  const protocolDir = join(repo, 'packages/protocol/fixtures/recorded')
  const matchApiDir = join(repo, 'packages/match-api/fixtures/recorded')
  mkdirSync(protocolDir, { recursive: true })
  const name = `${FIXTURE_PREFIX}-${GAMEMODE}`
  const files = [[join(matchApiDir, `${name}-bo1.json`), join(OUT_DIR, 'client.json')]]
  // **An empty exchange is not a recording.** The wire only reaches this
  // script through the orchestrator's trace, and a deployment that writes none
  // — production, deliberately (`.env.production`) — has nothing to say here.
  // The client half above is what that run recorded, and a fixture file
  // holding `[]` would claim otherwise.
  if (link.length > 0)
    files.push([join(protocolDir, `${name}-link.json`), join(OUT_DIR, 'link.json')])
  if (node.length > 0)
    files.push([join(protocolDir, `${name}-node.json`), join(OUT_DIR, 'node.json')])
  if (matchzy.length > 0)
    files.push([join(protocolDir, `${name}-matchzy.json`), join(OUT_DIR, 'matchzy.json')])
  for (const [target, source] of files) {
    writeFileSync(target, readFileSync(source, 'utf8'))
    say(`fixture ${target.replace(`${repo}/`, '')}`)
  }
  return bundle
}

// ---------------------------------------------------------------------------

const REBUILD = flags.get('rebuild')

let summary
try {
  if (REBUILD) {
    const raw = JSON.parse(readFileSync(join(REBUILD, 'raw.json'), 'utf8'))
    calls.push(...raw.calls)
    summary = write(raw)
  } else {
    const result = await run()
    summary = write(result)
    // A held room ends the way the run ended it, by `cancel` (T2b).
    if (result.match.state !== (HOLD ? 'cancelled' : 'ended')) process.exitCode = 1
  }
} catch (error) {
  process.stderr.write(
    `\x1b[31m[iron-match] ${error instanceof Error ? error.stack : String(error)}\x1b[0m\n`,
  )
  process.exitCode = 1
} finally {
  await cleanUp()
}
if (summary && QUIET) process.stdout.write(stringify(summary))
