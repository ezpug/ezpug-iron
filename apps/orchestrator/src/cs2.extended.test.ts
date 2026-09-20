import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { loadRootEnv } from './env'

/**
 * **The `EZPUG_CS2_TESTS` lane** (PRD-02 T13, re-pointed at the front door by
 * PRD-03 T5, made a matrix by T6): whole matches on real hardware, asserted.
 * **Puppets** play them on a CS2 container an `ezpug-node` on this box
 * started, MatchZy runs the match, the core plugin speaks the vocabulary over
 * its link, and the client — `scripts/iron-match.mjs`, the same script an
 * operator runs — watches it through nothing but the Match API.
 *
 * **Nobody types `css_start` any more.** Every case is `--simulate`: each
 * roster entry is a SteamID a MatchZy-Enhanced bot answers for, and they
 * ready up through `OnPlayerReady` — the handler `.ready` calls. So the ready
 * gate T1 fixed, the ready events T3 gave the vocabulary and the switches T3a
 * turned on are all on the path of every run here, where an RCON shortcut used
 * to be four assertions skipped. The escape hatch still exists
 * (`--force-start`) and **no case takes it**: each one asserts its own
 * `commands.rcon`, so "nothing typed at the match" is a measurement of the run
 * rather than a claim about the code. **Every row is zero now.** The last one
 * that was not is `drop`, which had to reach for `bot_kick ct` because no
 * `kick` could find a puppet; T7a gave it the front door and took the
 * shortcut away.
 *
 * **The matrix** (T6) is every shape of match the owner's two weeks of bugs
 * came out of, and one row each:
 *
 *  - a `pug` at **every size from one to five a side**, because the
 *    2026-09-18 stall was a 1v1 carrying a 5v5's `players_per_team` and the
 *    only size ever played here was ten;
 *  - **2v1**, uneven, which is the same bug wearing the other roster and what
 *    the platform's PRD-10 T1 lets a custom match ask for;
 *  - **wingman**, T3b's second format, which is a different engine game;
 *  - **a knifed map**, where a room of puppets never types `.stay` and the
 *    side-selection timer T3a turned on is the only thing that can decide it;
 *  - **a pause and an unpause** through the Match API, the facts for which are
 *    the core plugin's and not MatchZy's (T3);
 *  - **a puppet leaving and coming back**, the one thing that holds a loaded
 *    match at the gate.
 *
 * **And two rows that are not `matchzy` matches at all.** `retakes` (T10) is
 * three puppets in a mode a *community* plugin runs and the SDK's generic
 * emitter narrates — the run that decided whether cs2-retakes, which keeps
 * bots out of its queue, lets a puppet play at all — and the mode whose
 * manifest T10 turned into one group of ten, so nobody wins it.
 *
 * And (T8) `powerup-dm`,
 * whose flow and whose puppets are both the SDK's, played so that a puppet can
 * **tap the phone** — a player token, the widget socket, the mode's verb, the
 * `plugin_event` it leaves behind and the push that comes back. That is the
 * path only the owner's finger had ever proved.
 *
 * The stall itself is reproduced red one floor down, where it lives and where
 * it costs nothing: `match-config/matchzy.test.ts` replays MatchZy's own
 * `IsTeamReady` against the builder's output and forces the manifest's five
 * back in for a 1v1 ("is the stall itself when the manifest's five is sent for
 * a 1v1"). This lane is the other half — the same roster on a real server.
 *
 * **It shells out to that script on purpose.** The flow is one thing, not two:
 * a test that reimplemented "create a match, roster the puppets, wait" would
 * be a second answer to how a match is played, and the two would drift. The
 * script prints its summary as JSON; this file is the assertions.
 *
 * The demo rides along on the full pug: the script mints a presigned PUT into
 * the platform's dev MinIO on this box and the core plugin uploads to it, so
 * `demo.uploaded` is asserted there too (PRD-02 T21).
 *
 * What it needs, and what it says when it does not have it: a dev orchestrator
 * answering on {@link BASE_URL} with the `nodes` provider registered, and this
 * box enrolled as a node (`pnpm dev:up && pnpm dev && pnpm dev:node up`).
 * Skipped with a printed reason otherwise; `EZPUG_CS2_TESTS=required` makes
 * that skip a failure.
 *
 * The matrix costs **one CS2 container and the better part of two hours** —
 * puppets draw a four-round map more often than they win it, and the overtime
 * that follows is most of the spread — which is why it is never part of
 * `pnpm verify` and is opt-in even in the extended tier.
 * {@link ONLY} runs one row of it while something is being fixed. The script
 * releases its server in a `finally` and on a signal, and the summary it
 * returns carries the ledger — an open row here is a red test, not a note for
 * later.
 */

loadRootEnv()

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const BASE_URL = (
  process.env.EZPUG_IRON_BASE_URL ??
  process.env.EZPUG_IRON_PUBLIC_URL ??
  'http://127.0.0.1:3430'
).replace(/\/+$/, '')
/**
 * The lane is **opt-in twice over**: it does not run unless `EZPUG_CS2_TESTS`
 * is set at all (CLAUDE.md — ten minutes and a CS2 container is nobody's idea
 * of `pnpm verify`), and `required` turns a missing world from a printed skip
 * into a failure.
 */
const LANE = process.env.EZPUG_CS2_TESTS ?? ''
const DEMANDED = LANE === 'required'
/**
 * **One row of the matrix, by id** (`EZPUG_CS2_CASES=knife,pause`), for the
 * hour somebody is fixing exactly one of them. Unset is the whole matrix,
 * which is what `required` means and what a round is judged on.
 */
const ONLY = (process.env.EZPUG_CS2_CASES ?? '')
  .split(',')
  .map(id => id.trim())
  .filter(id => id !== '')
/**
 * **The lane's engine clock** (`simulation.timeScale`, T4), and it is the
 * lane's to choose rather than a request's — a production match is played at
 * the speed the players are in. Measured on this box: a 1v1 of puppets at `1`
 * takes about as long as the map does, and the matrix is eleven maps.
 *
 * The fork clamps `host_timescale` to 0.1–10 and the contract takes its bounds
 * from that; `2` is what the matrix runs at, because the demo the full pug
 * asserts is GOTV's and GOTV records in the server's time, not the wall's.
 */
const TIMESCALE = process.env.EZPUG_CS2_TIMESCALE ?? '2'
/**
 * The whole match, generously: allocation, a 67 GB game booting, bots playing
 * four rounds and as many overtimes as they need to break the tie — on a box
 * that is usually running something else. The script gets
 * {@link SCRIPT_MINUTES} and this is the outer wall.
 */
const SCRIPT_MINUTES = 35
const BUDGET_MS = (SCRIPT_MINUTES + 5) * 60_000

/** What `iron-match --json` prints, and everything this file reads off it. */
type Summary = {
  run?: string
  matchId?: string
  finalState?: string
  forcedEnd?: boolean
  endedReason?: { kind?: string } | null
  ledger?: { rows: number; open: number }
  payloads?: Record<string, number>
  counts?: Record<string, number>
  commands?: { rcon: number; total: number }
  paused?: { pause: unknown; unpause: unknown } | null
  dropped?: {
    rostered: string
    state: string
    standing: number
    frontDoor: { status?: string } | null
    stimulus: string | null
    left: { afterMs: number; standing: number } | null
    back: { afterMs: number; standing: number } | null
  } | null
  length?: {
    inForce: { durationSeconds?: number; fragLimit?: number } | null
    mapEnd: string | null
    seriesEnd: string | null
    winner: string | null
  }
  widget?: {
    steamId64: string
    expiresAt: string
    welcome: {
      matchId: string
      steamId64: string
      gamemode: string
      state: string
      locale: string | null
      commands: { name: string; chargesLeft: number | null; readyInMs: number }[]
    }
    grant: { status?: string; code?: string; chargesLeft?: number } | null
    claimed: number
    pushes: number
    corpseTaps: { afterMs: number; status?: string; code: string | null }[]
    corpse: { status?: string; code?: string; message?: string } | null
    deaths: number
    stranger: {
      minted: string
      steamId64: string
      result: { status?: string; code?: string } | null
    } | null
  } | null
  matchzy?: Record<string, number>
  pluginEvents?: Record<string, number>
  demoTarget?: string | null
  demo?: { uploaded: number; skipped?: string } | null
  simulation?: { puppets: number; timeScale: number; simulated: boolean } | null
}

/** One row of the matrix. */
type LaneCase = {
  /** What `EZPUG_CS2_CASES` names it. */
  id: string
  /** The sentence the test is called by. */
  what: string
  /** How many puppets are rostered — and so how many `player_ready` are owed. */
  puppets: number
  /** Everything after `--simulate --bots <puppets>`. */
  args: string[]
  /**
   * How many `rcon` commands this case sends *at the match*. **Zero, every
   * row**, since PRD-03 T7a gave the last one without a front door
   * (`drop`) one. The field stays because it is how a case that ever needs a
   * shortcut again would have to say so out loud rather than quietly raising
   * the count.
   */
  rcon?: number
  /**
   * **A match that is one round nobody wins** (PRD-03 T9). A free-for-all's
   * single round outlasts the match on purpose — the mode's `length` ends it
   * mid-round, so there is a `round_start` and never a `round_end`. Declared,
   * like {@link rcon}, so that a round-based row which stopped ending rounds
   * cannot hide behind it.
   */
  roundless?: true
  /** The facts only this case can produce. The invariants are in {@link play}. */
  facts?: (summary: Summary) => void
}

/**
 * **Every size, because the stall was a size** (T1). `players_per_team` comes
 * off the roster now — the smaller team's count, capped by the manifest — so
 * each of these is a different number in the match file and a different
 * answer from MatchZy's `IsTeamReady`. Five a side is the one the demo and the
 * full vocabulary are asserted on, because it is the match the owner actually
 * plays.
 */
const SIZES = [2, 4, 6, 8, 10]

const CASES: LaneCase[] = [
  ...SIZES.map(
    (puppets): LaneCase => ({
      id: `pug-${puppets / 2}v${puppets / 2}`,
      what: `plays a ${puppets / 2}v${puppets / 2} pug that ${puppets} puppets readied up for`,
      puppets,
      args: [],
      facts: summary => {
        readiedUp(summary, puppets)
        // **The full pug carries the demo** (PRD-02 T21, T21a). A forced end
        // cuts GOTV off before it finishes the file and a box without the
        // platform's S3 credentials never minted a target at all; neither is
        // asked about.
        if (puppets === 10 && !summary.forcedEnd && summary.demoTarget) {
          expect(summary.payloads?.demo_available, 'the server never announced a demo').toBe(1)
          expect(summary.payloads?.['demo.uploaded'], 'the demo never landed in MinIO').toBe(1)
          expect(summary.demo, 'the ended fact did not count the demo').toEqual({ uploaded: 1 })
        }
      },
    }),
  ),
  {
    // **Uneven, which is the same stall wearing the other roster** (T1's own
    // note): MatchZy has one `players_per_team` for both teams, so the larger
    // team's count would refuse the single player for ever. It is the smaller
    // team's, and this is the case that says so on hardware. The platform's
    // PRD-10 T1 is what lets a custom match ask for it.
    id: 'pug-2v1',
    what: 'plays an uneven 2v1, which one number for both teams could not',
    puppets: 3,
    args: [],
    facts: summary => readiedUp(summary, 3),
  },
  {
    // **A different engine game** (T3b): `game_mode 2`, `live_wingman.cfg`
    // and a map reload before anything else happens. `de_dust2` is a full
    // map played under it on purpose — the catalog has no wingman layouts and
    // substitutes nothing, so what a full map does under wingman is a fact
    // this lane owns rather than an assumption.
    id: 'wingman',
    what: 'plays a wingman match, the other format on the wire',
    puppets: 4,
    args: ['--format', 'wingman'],
    facts: summary => {
      readiedUp(summary, 4)
      // **The map reload, measured.** MatchZy switches the engine to
      // `game_mode 2` from the match file and reloads the map when the server
      // was not already in that mode (`Utility.cs` `SetCorrectGameMode`,
      // `IsMapReloadRequiredForGameMode`), and the core plugin announces
      // itself again on the new map — so a wingman match says `server_ready`
      // **twice** where every competitive one says it once. Two runs on the
      // dev node agree. The client is still told once (`match.server_ready`,
      // asserted for every case), so this is the reload showing through the
      // link rather than a fact said twice.
      expect(
        summary.payloads?.server_ready,
        'no second server_ready: the map was never reloaded for game_mode 2',
      ).toBe(2)
    },
  },
  {
    // **A knifed map, and nobody to answer it.** Stock MatchZy waits for the
    // knife winner to type `.stay` or `.switch`; a bot never will, so the map
    // would hold the box until a human looked. MatchZy-Enhanced's
    // side-selection timer is what decides it instead, and T3a turned that on
    // in the image's own cfg for exactly this. The two facts below are T3's
    // vocabulary reaching a real server for the first time.
    id: 'knife',
    what: 'knifes for the side and lets the timer decide it, because puppets never type .stay',
    puppets: 4,
    args: ['--sides', 'knife'],
    facts: summary => {
      readiedUp(summary, 4)
      expect(summary.payloads?.knife_start, 'the knife round never began').toBe(1)
      expect(summary.payloads?.knife_end, 'the knife round was never decided').toBe(1)
    },
  },
  {
    // **A pause and an unpause through the front door**, which is the path
    // the platform's admin console takes and the only one a client has. Both
    // facts are the core plugin's `MatchZyFlow` — MatchZy's own pause events
    // are dropped at the door because the plugin already says it (T3) — so
    // this is where that decision meets hardware.
    id: 'pause',
    what: 'pauses and unpauses a live match, and the core plugin is what says so',
    puppets: 2,
    args: ['--pause'],
    facts: summary => {
      readiedUp(summary, 2)
      expect(summary.paused, 'the run never paused').not.toBeNull()
      expect(summary.payloads?.match_paused, 'the match never paused').toBe(1)
      expect(summary.payloads?.match_unpaused, 'the match never came back').toBe(1)
    },
  },
  {
    // **One puppet leaves and comes back, through the front door.** The window
    // is the warmup, because that is the only place a missing rostered player
    // changes anything: the fork holds a loaded match at the gate while any
    // rostered SteamID is absent (`AreAllConfiguredPlayersConnectedAndOnCorrectTeams`,
    // T3a's sentence), and once the match is live it stops caring.
    //
    // **This row used to be the one that typed at a match, and PRD-03 T7a is
    // why it no longer does.** `kick` is gated on the orchestrator's presence
    // map; that map is filled from `player_connected` / `player_disconnected`;
    // and under a `matchzy` flow the core plugin saw ten plain bots, because
    // MatchZy-Enhanced seats the bodies itself and keeps which bot plays which
    // roster entry in a private dictionary. So the map was empty, no player
    // command could reach anybody, and the stimulus had to be `bot_kick ct`
    // over RCON. T7a reads the fork's mapping off the lines simulation mode
    // writes to the server console — one process, one `Console.Out` — and
    // casts each body from it, so every puppet is announced like the person it
    // plays. The kick below is addressed to the **rostered** SteamID, the only
    // id a client ever holds, and it lands: `rcon` is zero for every row of
    // this matrix now.
    //
    // The return is the fork's own reconcile pass: the room goes one short, it
    // adds a bot on the side whose roster slot is empty, maps it onto that
    // entry and re-readies it. Both halves are watched, because a `back` that
    // never saw a `left` is a room that was simply never disturbed, which is
    // what the first cut of this case recorded — and **the match goes live**,
    // which it could not do while a rostered SteamID was missing, so the
    // go-live is the second proof that the replacement was mapped onto the
    // free slot.
    id: 'drop',
    what: 'loses a puppet in warmup to a kick by its rostered id, gets it back and still goes live',
    puppets: 2,
    args: ['--drop-puppet'],
    facts: summary => {
      expect(summary.dropped, 'nothing was ever taken off the server').not.toBeNull()
      // **The front door, and it opens.** Red before T7a, when the same call
      // came back `player_not_in_match` because nothing had ever said the
      // puppet was here.
      expect(
        JSON.stringify(summary.dropped?.frontDoor),
        'the rostered SteamID was not kickable: the puppet is not in the presence map',
      ).not.toContain('player_not_in_match')
      expect(summary.dropped?.frontDoor?.status, 'the kick was not applied').toBe('applied')
      // **In the warmup, which is the only window that proves anything.** Once
      // a match is live the fork's reconcile pass no longer runs and nothing
      // puts the body back, so a kick that landed late would record a room
      // that emptied and stayed that way. The script waits on the stream for
      // the room to be announced rather than on its own five-second poll.
      expect(summary.dropped?.state, 'the puppet was dropped out of a live match').toBe('ready')
      expect(summary.dropped?.left, 'nobody ever left the server').not.toBeNull()
      expect(summary.dropped?.back, 'the room never filled back up').not.toBeNull()
      // The room is read off `presence`, which only holds a puppet because the
      // core plugin announces one — the other half of the same fix.
      expect(summary.dropped?.standing, 'the presence map never held the room').toBe(2)
      // **The coming and the going are in the durable log**, which is what
      // T6 measured as missing: two puppets and a replacement make three
      // `player_connected`, and the body that was kicked is one of the
      // `player_disconnected`. Before T7a a room of puppets produced neither,
      // whatever happened on the server.
      expect(
        summary.payloads?.player_connected ?? 0,
        'the puppets and their replacement were not all announced',
      ).toBeGreaterThanOrEqual(3)
      expect(
        summary.payloads?.player_disconnected ?? 0,
        'nothing in the durable log says a puppet left',
      ).toBeGreaterThanOrEqual(1)
      // **And it went live anyway**, which is what the case is really for: the
      // fork holds a loaded match in warmup while any rostered SteamID is
      // absent, so the `going_live` every row of this matrix asserts is the
      // proof the body came back and was mapped onto its roster slot again.
      //
      // The durable log says each puppet readied **once**, however many times
      // the fork said it — the "already said" rule (T5) doing its work on a
      // real return rather than on a poll.
      //
      // **The gate is the one thing this row does not pin, and the reason is a
      // vendor property.** The kick lands the moment the room is announced,
      // which is before either side has crossed the gate; the fork then refills
      // with `bot_join_team <side>; bot_quota n+1`, and the engine is free to
      // put that body on the *other* side while the fork maps it onto the empty
      // roster slot regardless. Its `IsTeamReady` counts bodies per CT/T side
      // (T5's finding), so when that happens the emptied team never passes the
      // gate, no `all_players_ready` is ever sent, and the fork force-readies
      // both sides to get live — measured here: ten `team_ready` on the wire,
      // all of them `team2`, and `player_ready` for team1's player carrying
      // team2's label. Which side the replacement lands on is the engine's
      // lottery, so pinning two `team_ready` here would be pinning a coin toss.
      // Every other row of the matrix asserts the whole gate.
      expect(summary.payloads?.player_ready, 'not every puppet readied up').toBe(2)
    },
  },
  {
    // **Three puppets in a retakes match** (PRD-03 T10), and the mode whose
    // puppet claim this task decided. The doubt was real and it was about the
    // *queue*: cs2-retakes never auto-joins a bot
    // (`QueueManager.AddConnectingPlayer` returns at `player.IsBot`) and never
    // syncs one into its active players, so the reasonable guess was that a
    // puppet would stand in spectator for the whole match. It does not,
    // because nothing seats a puppet through that door: the SDK's puppeteer
    // asks the engine (`bot_add`), the engine puts the body on a side, and the
    // plugin's *team* hook — which has no bot filter — takes it into
    // `ActivePlayers` like anybody else.
    //
    // **And it is the mode's `slots.teams: 1` on hardware.** A retake has an
    // attacking and a defending side and the plugin rebuilds both every round
    // out of one pool, so no EZPug team survives a round; the manifest says
    // one group of ten now, and the terminal facts below name nobody.
    //
    // It ends **on its rounds** — the one end cs2-retakes can honestly reach
    // (T9) — so its terminal facts carry no reason: the win panel, not a
    // length.
    id: 'retakes',
    what: 'plays a retakes of three puppets and ends it on its rounds, with nobody the winner',
    puppets: 3,
    args: ['--gamemode', 'retakes', '--no-demo', '--max-live-minutes', '12'],
    facts: summary => {
      // **Nobody readies up here**: a `plugin` flow with an open join has no
      // ready system at all, and the SDK's generic emitter ends the warmup on
      // a timer. So the facts T5 asserts for every MatchZy row must be absent,
      // which is also how a row that quietly became a MatchZy match is caught.
      expect(summary.payloads?.player_ready ?? 0, 'a plugin flow ran a ready system').toBe(0)
      // **The puppets are announced like people** (T7): three roster entries,
      // three bodies, each `player_connected` under its rostered SteamID.
      expect(
        summary.payloads?.player_connected ?? 0,
        'the three puppets were not announced',
      ).toBeGreaterThanOrEqual(3)
      // **No winner for one team** (T10, and `GenericFlow.Winner` since T9):
      // the engine keeps a CT and a T score in a retake too, and the side that
      // happened to lead did not win anything a client should record.
      expect(summary.length?.winner, 'a one-team mode named a winning team').toBeNull()
      // **The game's own end, which is what "ends on its rounds" means**:
      // `mp_maxrounds` from the request's rules, the win panel, and a terminal
      // fact with no `reason` — the mode's `length` is an idle timeout only,
      // and nobody was idle.
      if (!summary.forcedEnd) {
        expect(
          summary.length?.mapEnd,
          'the map was ended by a length, not by its rounds',
        ).toBeNull()
        expect(summary.length?.seriesEnd).toBeNull()
      }
    },
  },
  {
    // **A puppet taps the phone** (PRD-03 T8), on the second of the two rows
    // that are not `matchzy` matches: `powerup-dm` is the mode with a widget, its flow
    // is the SDK's own (`GenericFlow` reads the story off the engine), and its
    // puppets are the SDK's too (T7's `Puppeteer`, not MatchZy-Enhanced's
    // simulation mode). Everything below rides the path **only the owner's
    // finger had ever taken**: a player token, a socket, a tap, and a phone
    // that gets an answer back.
    //
    // Three taps, three different assertions, and none of them through
    // `/v1/matches/:id/commands` — a tap is the widget socket's own frame, so
    // this row's `rcon` is zero like every other.
    id: 'widget',
    what: "taps powerup-dm's widget as a puppet, and is refused as a corpse and as a stranger",
    puppets: 6,
    roundless: true,
    args: ['--gamemode', 'powerup-dm', '--widget', '--no-demo', '--max-live-minutes', '12'],
    facts: summary => {
      const widget = summary.widget
      expect(widget, 'the run never opened a widget socket').not.toBeNull()
      // **The greeting**: the token was minted for a rostered puppet and the
      // socket answered for that match, that player and that mode, with the
      // verb the manifest declares and a charge in hand.
      expect(widget?.welcome.steamId64, 'the phone was greeted as somebody else').toBe(
        widget?.steamId64,
      )
      expect(widget?.welcome.matchId, 'the phone was greeted for another match').toBe(
        summary.matchId,
      )
      expect(widget?.welcome.gamemode).toBe('powerup-dm')
      expect(widget?.welcome.state, 'the phone said hello to a match that was not live').toBe(
        'live',
      )
      expect(
        widget?.welcome.commands.map(verb => verb.name),
        "the hello did not carry the mode's verb",
      ).toEqual(['powerup'])
      // **The grant reaches the SDK and the power-up applies.** The charge is
      // one per life (`gamemodes/powerup-dm/manifest.json`), so an applied tap
      // leaves none — the SDK's own number, come back over the socket.
      expect(widget?.grant?.status, 'the tap did not apply').toBe('applied')
      expect(widget?.grant?.chargesLeft, "the SDK did not spend the life's charge").toBe(0)
      // **…and `plugin_event` lands.** In the durable log, where the platform
      // reads it, and on the phone that asked, which is the socket's other
      // half: a widget subscribes to the hub and sees its own tap land.
      expect(
        summary.pluginEvents?.powerup_claimed ?? 0,
        'no powerup_claimed in the durable log',
      ).toBeGreaterThanOrEqual(1)
      expect(widget?.claimed ?? 0, 'the phone never saw its own claim').toBeGreaterThanOrEqual(1)
      // **A push goes the other way** (PRD-02 T26): `radar_peek` is five
      // seconds of everybody else's positions, pushed to this one phone every
      // half second and written down nowhere. Never stored, never replayed —
      // so the only place it can be counted is a socket that was open.
      expect(widget?.pushes ?? 0, 'the peek never reached the phone').toBeGreaterThanOrEqual(1)
      expect(
        summary.payloads?.position_tick ?? 0,
        'a position tick was stored: the peek must be ephemeral',
      ).toBe(0)
      // **A dead puppet is refused `NotAlive`**, which is the mode's own
      // verdict (`PowerupDm.OnPlayerCommand`) turned into a refusal by the
      // SDK's command table, in this player's language.
      expect(widget?.corpse?.status, 'no tap ever met a corpse').toBe('rejected')
      expect(widget?.corpse?.code).toBe('not_alive')
      // **A stranger.** `powerup-dm` opens its roster, so a player token is
      // minted for a SteamID the request never named — that is the "unless the
      // mode is open-join" half; the closed half is a `pug`'s, refused
      // `player_not_in_match` at the door and pinned against the fake and the
      // real orchestrator by the conformance suite. What the SDK then does
      // with a tap from a body that is not on the server is this row's:
      expect(widget?.stranger?.minted, 'an open-join mode refused a token').toBe('ok')
      expect(widget?.stranger?.result?.status).toBe('rejected')
      expect(widget?.stranger?.result?.code, 'a stranger was not refused').toBe('not_in_match')
      // **And the match ends because its manifest says how long it is** (PRD-03
      // T9), not because a human released the box: `going_live` carries the
      // duration in force — the manifest's ten minutes over the lane's engine
      // clock — and both terminal facts say the clock ended it, with nobody
      // named the winner of a free-for-all.
      expect(summary.length?.inForce?.durationSeconds, 'going_live carried no countdown').toBe(
        Math.ceil(600 / Number(TIMESCALE)),
      )
      expect(summary.length?.mapEnd, 'the map was not ended by the mode’s length').toBe(
        'time_limit',
      )
      expect(summary.length?.seriesEnd).toBe('time_limit')
      expect(summary.length?.winner, 'a free-for-all named a winning team').toBeNull()
    },
  },
]

/**
 * **The room readied up** (T5), which is the whole reason this lane has this
 * shape: one `player_ready` per puppet, then each team through the gate once —
 * MatchZy re-announces a team that is already through on every later ready and
 * the door says each fact once (`matchzy/translate.ts`) — and then everybody,
 * with a countdown.
 */
function readiedUp(summary: Summary, puppets: number): void {
  expect(summary.payloads?.player_ready, 'not every puppet readied up').toBe(puppets)
  expect(summary.payloads?.team_ready, 'the two teams did not pass the gate').toBe(2)
  expect(summary.payloads?.all_ready, 'the room was never all ready').toBe(1)
}

/** How long each case took and what it played, printed as the matrix's own note (T13). */
const runtimes: { id: string; minutes: number; rounds: number; overtime: boolean }[] = []

async function why(): Promise<string | null> {
  if (LANE === '') return 'EZPUG_CS2_TESTS is not set'
  let health: { checks?: { providers?: Record<string, unknown> } }
  try {
    const response = await fetch(`${BASE_URL}/healthz`, {
      signal: AbortSignal.timeout(3_000),
    })
    health = (await response.json()) as typeof health
  } catch {
    return `no orchestrator at ${BASE_URL} — \`pnpm dev:up\` then \`pnpm dev\``
  }
  if (!health.checks?.providers?.nodes)
    return 'the orchestrator has no `nodes` provider — set EZPUG_IRON_PROVIDERS=sim,nodes and restart it'
  if (!existsSync(`${REPO}.ezpug-node/node.json`))
    return 'this box is not enrolled as a node — `pnpm dev:node up`'
  return null
}

const reason = await why()
if (reason !== null && !DEMANDED)
  process.stderr.write(
    `\n[orchestrator] skipping the CS2 lane — ${reason}\n` +
      '               demand it with EZPUG_CS2_TESTS=required once the dev node is up.\n\n',
  )

/**
 * Play one row: spawn the operator's own script, parse its summary, and hold
 * it to everything that is true of **every** match on this lane. The case's
 * own {@link LaneCase.facts} are the part only it can prove.
 */
function play(lane: LaneCase): Summary {
  const startedAt = performance.now()
  const run = spawnSync(
    'node',
    [
      'scripts/iron-match.mjs',
      '--json',
      '--simulate',
      '--bots',
      String(lane.puppets),
      '--timescale',
      TIMESCALE,
      '--timeout-minutes',
      String(SCRIPT_MINUTES),
      ...lane.args,
    ],
    { cwd: REPO, encoding: 'utf8', timeout: BUDGET_MS },
  )
  // The exit code first: a run that died has no summary to parse, and its
  // stderr is the only thing worth reading when it did.
  expect(run.status, `iron-match exited ${run.status}\n${run.stderr.slice(-6_000)}`).toBe(0)
  // Everything the script says to a human goes to stderr; stdout under
  // `--json` is the summary and nothing else.
  const summary = JSON.parse(run.stdout.trim() || '{}') as Summary
  const rounds = summary.payloads?.round_end ?? 0

  // **Puppets, and the marker every consumer reads** (T4): the resource said
  // the match was simulated, so every fact of it carries `source.simulated`
  // and nobody can mistake it for a real one.
  expect(summary.simulation, 'the run did not ask for puppets').toMatchObject({
    puppets: lane.puppets,
    simulated: true,
  })
  // **Nothing was typed at the match** (Attitude 2). This is the assertion the
  // escape hatch used to stand in front of: a `--simulate` match that went
  // live with a zero here went live because players readied.
  expect(summary.commands?.rcon, 'the run took an RCON shortcut').toBe(lane.rcon ?? 0)

  // The match played itself out: MatchZy said so and the machine agreed.
  expect(summary.finalState).toBe('ended')
  expect(summary.payloads?.going_live, 'MatchZy never went live').toBe(1)
  if (lane.roundless) {
    expect(summary.payloads?.round_start, 'the one round never started').toBeGreaterThanOrEqual(1)
    expect(rounds, 'a round ended in a match whose length outlasts its round').toBe(0)
  } else {
    expect(rounds, 'no round was played').toBeGreaterThanOrEqual(1)
  }
  expect(summary.payloads?.['match.ended'], 'no match.ended reached the client').toBe(1)
  // `series_end` only when MatchZy finished the series itself. A drawn map
  // goes to overtime, and CS2 works its overtime clinch out from the
  // `mp_maxrounds 24` MatchZy's own `live.cfg` sets rather than the four this
  // request asked for, so a bots match can wander; the script ends one that
  // does (`--max-live-minutes`) and says it had to. Everything above is true
  // either way, and that is what this lane is for.
  if (summary.forcedEnd) {
    expect(summary.endedReason?.kind, 'a forced end must say so').toBe('force_ended')
  } else {
    expect(summary.payloads?.series_end, 'the series never ended').toBe(1)
    expect(summary.payloads?.map_end, 'the map never ended').toBe(1)
  }

  // A ledger row was opened and it is closed. This is the P1 the working
  // rules name: a live test that leaves a server running.
  expect(summary.ledger?.rows ?? 0).toBeGreaterThanOrEqual(1)
  expect(summary.ledger?.open, 'a ledger row is still open').toBe(0)
  expect(summary.counts?.openServersAfter, 'a server is still running').toBe(0)

  // **The link and the MatchZy door both carried the match**, proven by
  // events only one of them can produce rather than by counting frames:
  // `server_ready` and `player_death` are the core plugin's, over the link;
  // `going_live` and `round_end` exist only because MatchZy POSTed them to
  // `/matchzy/log` and the translator turned them into these.
  //
  // **The client is told once; the server may say it more than once.**
  // `match.server_ready` is the durable fact and is exact. The raw
  // `server_ready` is only `>= 1`, because a **map reload re-announces the
  // server** and wingman needs one to switch `game_mode` — measured here, and
  // pinned as that case's own fact rather than smoothed away.
  expect(summary.payloads?.['match.server_ready'], 'the client was not told once').toBe(1)
  expect(
    summary.payloads?.server_ready ?? 0,
    'the plugin never said it was ready',
  ).toBeGreaterThanOrEqual(1)
  expect(summary.payloads?.player_death ?? 0, 'nobody died: no link events').toBeGreaterThan(0)

  lane.facts?.(summary)

  // **Four regulation rounds, and whatever the draw cost.** Whether a short
  // `mp_maxrounds` can force an overtime *reliably* is a question this matrix
  // answers by counting rather than by asserting (T6): a map that clinches
  // 3–1 never sees one, and a request cannot make two evenly matched bots
  // draw on demand.
  runtimes.push({
    id: lane.id,
    minutes: Math.round(((performance.now() - startedAt) / 60_000) * 10) / 10,
    rounds,
    overtime: rounds > 4,
  })
  return summary
}

describe.skipIf(reason !== null && !DEMANDED)('puppets play real matches on the dev node', () => {
  if (reason !== null) {
    it('is demanded but its world is absent', () => {
      expect.fail(`EZPUG_CS2_TESTS=required: ${reason}`)
    })
    return
  }

  afterAll(() => {
    if (runtimes.length === 0) return
    process.stderr.write(
      `\n[orchestrator] the CS2 matrix, at timescale ${TIMESCALE}:\n${runtimes
        .map(
          row =>
            `               ${row.id.padEnd(12)} ${String(row.minutes).padStart(5)} min  ` +
            `${String(row.rounds).padStart(2)} rounds${row.overtime ? ' (overtime)' : ''}`,
        )
        .join('\n')}\n\n`,
    )
  })

  for (const lane of CASES) {
    const chosen = ONLY.length === 0 || ONLY.includes(lane.id)
    it.skipIf(!chosen)(`${lane.id}: ${lane.what}`, () => void play(lane), BUDGET_MS + 30_000)
  }
})

/**
 * The recorded files this lane's script writes are checked where they live
 * (`packages/protocol`, `packages/match-api`); here only that the run bundle's
 * own reader is honest about the script it names.
 */
describe('the iron-match script', () => {
  it('is where every doc and this lane says it is', () => {
    expect(existsSync(`${REPO}scripts/iron-match.mjs`)).toBe(true)
    const pkg = JSON.parse(readFileSync(`${REPO}package.json`, 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts['iron:match']).toBe('node scripts/iron-match.mjs')
  })

  it('is documented by the name an operator types, and so is its trace', () => {
    const operations = readFileSync(`${REPO}docs/operations.md`, 'utf8')
    const readme = readFileSync(`${REPO}README.md`, 'utf8')
    const example = readFileSync(`${REPO}.env.example`, 'utf8')
    for (const doc of [operations, readme]) expect(doc).toContain('pnpm iron:match')
    expect(operations).toContain('EZPUG_IRON_TRACE_FILE')
    expect(operations).toContain('EZPUG_CS2_TESTS')
    // The variable the trace is turned on with, commented out and explained.
    expect(example).toContain('#EZPUG_IRON_TRACE_FILE=')
  })

  it('offers every flag its own help text names', () => {
    const script = readFileSync(`${REPO}scripts/iron-match.mjs`, 'utf8')
    const help = script.slice(script.indexOf('const HELP ='), script.indexOf('function args('))
    for (const flag of help.matchAll(/^ {2}--([a-z-]+)/gm))
      expect(
        script.includes(`flags.get('${flag[1]}')`) || script.includes(`flags.has('${flag[1]}')`),
        `--${flag[1]} is in --help but nothing reads it`,
      ).toBe(true)
  })

  /**
   * **The matrix is the PRD's list, and a row that quietly disappeared would
   * be a lane case nobody missed.** Cheap, and it runs in `pnpm verify` where
   * the lane itself never does.
   */
  it("covers every shape PRD-03 T6 names, T10's retakes and T8's phone", () => {
    const ids = CASES.map(lane => lane.id)
    expect(ids).toEqual([
      'pug-1v1',
      'pug-2v2',
      'pug-3v3',
      'pug-4v4',
      'pug-5v5',
      'pug-2v1',
      'wingman',
      'knife',
      'pause',
      'drop',
      // T10's: three puppets in `retakes`, the mode whose one-team shape and
      // whose puppet claim that task decided.
      'retakes',
      // T6's matrix is the ten above `retakes`. `widget` is **T8**'s:
      // `powerup-dm`, the SDK's own flow and the SDK's own puppets, tapped
      // from a phone.
      'widget',
    ])
    // **No row of the matrix types at the match.** Every one goes live because
    // players readied and nothing else, and every one takes its stimulus
    // through the Match API — `drop` included, since PRD-03 T7a announced the
    // puppets MatchZy seats and gave `kick` somebody to find. A row that
    // quietly grew an RCON would be caught here.
    expect(CASES.filter(lane => (lane.rcon ?? 0) > 0).map(lane => lane.id)).toEqual([])
  })
})
