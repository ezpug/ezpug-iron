# Gamemodes

What a gamemode is on the iron side, what every field of its manifest means, and how the
platform is expected to render one. Written for the platform loop (PRD-09 T6, T7) and for
whoever authors the next manifest; the wire shape lives in `docs/match-api.md` under
"Gamemode (the manifest)" and the schema in `packages/match-api/src/resources/gamemode.ts`.
Decisions 14–17 in `docs/decisions.md` are the why.

## A gamemode is a manifest

One directory per mode, `gamemodes/<id>/manifest.json`, authored as data. The orchestrator
ships the manifests it knows and serves them whole at `GET /v1/gamemodes` (`pug` first) and
one at a time at `GET /v1/gamemodes/:gamemodeId`. The package exports the same four as
`SHIPPED_GAMEMODES`, so the fake orchestrator serves exactly what the real one will.

A manifest says what the **server** does for a match of this mode: which plugins the core
plugin enables, which cfg it execs, which maps it plays, who owns match flow, what it
records, what a player may do from a phone. It never says what the platform makes of the
result: `ranked` is `false` by construction, rating and ranking are the platform's, and the
queue's `pug` counts because the platform says so, not the manifest.

Every server runs one image with every plugin baked in (decision 16). On assignment the
core plugin enables exactly the folders the manifest names, execs its cfg files, applies its
cvars, changes to the request's first map. Nothing is fetched at boot.

The manifest is validated by the package's test suite (`gamemodes.test.ts`): a manifest that
does not parse fails `pnpm verify`. The rules under "What the tier allows" are checked at
parse time, so a manifest that parses is one the loader can act on.

## The tiers

Three tiers, each proved by one shipped mode (decision 15), plus the queue's mode:

| Tier     | Mode               | What it is |
| -------- | ------------------ | ---------- |
| `config` | `flying-scoutsman` | stock CS2 by cfg alone: no plugin anywhere. The match flow is the SDK's generic emitter, read off the engine ("The generic flow" below) |
| `plugin` | `retakes`          | two vendored community plugins (B3none/cs2-retakes and a weapon allocator, `docs/pins.md`) under the core plugin: its own rounds and spawns, its own map pool, open join, events without a demo. Its settings arrive as a file, not as cvars ("A vendored plugin's own config file" below), and the SDK's generic emitter tells the match flow |
| `plugin` | `pug`              | 5v5 on MatchZy: knife, overtime, demo, round backups — the queue's default and its only mode |
| `sdk`    | `powerup-dm`       | an original mode on `EZPug.Sdk`: player commands, per-player state and a phone widget |

The tier decides what the rest of the manifest may say. What each mode actually does on the
server is PRD-02's work; the manifests were authored first so both loops build against the
same data.

## The fields

| Field | Meaning |
| ----- | ------- |
| `id` | kebab-case, the directory name, the value a `MatchRequest.gamemode` carries |
| `game` | `cs2` or `csgo`. One game per manifest; a CS:GO variant would be its own id. Every shipped mode is `cs2` and `csgo` is refused `no_capable_server` this round (decision 18) |
| `tier` | `config`, `plugin` or `sdk` — see above |
| `title`, `description` | `{ de, en }`, both always present, German first. The card's headline and its one paragraph |
| `slots` | how many people play and how they arrive — `teamSize`, `teams`, `openJoin`, below |
| `flow` | who owns match flow. `matchzy`: MatchZy runs ready-up, knife, live, the series; its events are translated into the vocabulary once, by the orchestrator, off the HTTP remote log the core plugin points at it ("The `matchzy` flow" below). `plugin`: the mode's plugin may speak `going_live`, `round_end`, `map_end`, `series_end` itself, and the SDK's generic emitter speaks for it when it does not. `none`: no plugin at all — the generic emitter is the whole story ("The generic flow" below) |
| `records` | `demo`: a demo is recorded and uploaded to the request's `demoUploadUrl` **by the server** (MatchZy records for a `matchzy` flow, the SDK for any other; the core plugin always owns the PUT), `demo.uploaded` follows, the match waits for it past `series_end`, and every durable event flows. `events`: the durable events only. `none`: orchestration facts only; the game's events still stream live but nothing is promised durably. Positions and chat are never records |
| `ranked` | always `false`. The manifest states what the server records, never what counts |
| `maps` | `"any"` — the request plans whatever it likes, workshop maps included; the platform's map pool decides. Or an allow-list `{ catalog: [engine names], workshop: [published-file ids] }`; a request planning a map outside it is refused `map_not_allowed` at the door. A plugin that ships spawn files per map lists them; a mode built for one map lists one |
| `plugins` | folder names under `addons/counterstrikesharp/plugins/`, enabled in this order. Empty for a config mode, non-empty otherwise |
| `cfg` | files under the server's `cfg/`, exec'd in this order after the map loads and — a second later, in a console frame of their own, because the engine reconciles a cvar once per frame and two writes in one net out (`GamemodeLoader.CvarSettleMs`, PRD-02 T22a) — before the flat cvars and the match's own rules. A config mode's whole truth is its cfg |
| `cvars` | at most 64 name → string pairs the mode sets after its cfg. Applied over a request's `rules.cvars` and under what the rules derive (`mp_maxrounds`, overtime, warmup): neither side can undo what the other needs. Twelve are protected and refused at parse time, below |
| `capabilities` | six booleans, below |
| `commands` | the player-scoped verbs an `sdk` mode accepts, below. Empty otherwise |
| `widget` | `{ entry, needs }` for an `sdk` mode with a phone widget, below. Absent otherwise |
| `version` | the manifest's own semver, bumped with any change to the file |
| `sdkVersion` | the SDK version the manifest was authored against. A loader older in major refuses it |

### Slots

| Field | Meaning |
| ----- | ------- |
| `teamSize` | the most one team holds. The platform's room refuses an eleventh player for a `5` |
| `teams` | `2` for a sided mode, `1` for a free-for-all. A free-for-all request still sends `teamA` and `teamB`, with `teamB.players` empty |
| `openJoin` | `true` means people may connect without being rostered: the server lets them in, the orchestrator relays `player.joined` with `rostered: false`, and the platform answers with a `profile` command so the server learns their name, locale, rating and loadout. `false` means the roster is the guest list and nobody else gets past the SteamID check |

### Capabilities

| Capability | True means |
| ---------- | ---------- |
| `positions` | the core plugin streams `position_tick`s on the match's stream (never stored) |
| `chat` | chat lines are relayed as `chat_message` and `chat_command` |
| `playerCommands` | the verbs in `commands` are accepted from a widget or as `!verb` in chat. True exactly when `commands` is non-empty |
| `widget` | a phone widget exists. True exactly when the `widget` block does; implies `playerCommands` |
| `backups` | round backups cross the link as they are written (`backup_written`), so a crashed server can be recovered mid-match (PRD-02 T14). Needs a flow owner (`flow` is not `none`); the core plugin honours it for `matchzy` |
| `scoreboardRating` | EZ Rating shows on the scoreboard Premier-style from the roster's `rating` (decision 21) |

### Player commands

A player command is a verb one player fires: from the widget's own socket (decision 17) or
as `!name` in chat. The SDK enforces the limits before the mode sees the tap; a refused tap
is answered on the socket, an accepted one becomes whatever the mode does (usually a
`plugin_event`).

| Field | Meaning |
| ----- | ------- |
| `name` | the bare lowercase verb, the same grammar as a `chat_command`'s `command` — a widget tap and `!powerup` in chat name the same thing |
| `title`, `description` | what the button says and what it does, `{ de, en }`. The description is optional; the title is not |
| `cooldownMs` | the least time between two uses by one player; `0` (the default) is none |
| `charges` | `{ count, per }` or `null` (the default) for unlimited. `per` is `life`, `round`, `map` or `match` — the window the count refills in. `powerup-dm`'s button is one per `life` |
| `args` | optional. A JSON Schema (draft 2020-12) with `type: object` describing the tap's arguments. The widget validates before it sends and the plugin before it acts, from the one document. Absent means the verb takes none |

Names are unique within a manifest; at most 32 verbs.

### The widget block

An `sdk` mode's phone widget (decision 17). Only an `sdk` mode may have one, and having one
turns on `capabilities.widget` and `capabilities.playerCommands`.

| Field | Meaning |
| ----- | ------- |
| `entry` | the built bundle's path, relative to the mode's widget output (`gamemode-kit` produces it in PRD-02). The orchestrator serves it as an HTML document; the platform mounts that document in a sandboxed `iframe` and never hosts the code itself |
| `needs` | what the host must inject, a non-empty subset of `tokens` (the platform's design tokens as CSS custom properties), `locale` (`de` or `en`, the player's) and `playerToken` (the match- and SteamID-scoped token the widget opens its own socket with; a widget that needs it renders a "watching only" state when the host passes `null`) |

Everything under "The widget host" below is how those three arrive.

### Protected cvars

Twelve cvar names are the orchestrator's or the request's, never a manifest's; a manifest
naming one does not parse:

| Cvar | Whose |
| ---- | ----- |
| `hostname` | the request's `branding.hostname`, or the orchestrator's default |
| `sv_password`, `tv_password`, `tv_relaypassword` | the orchestrator's — they are the connect facts it hands the client |
| `rcon_password` | the orchestrator's, and never leaves it |
| `sv_setsteamaccount` | the GSLT the orchestrator leases per running server |
| `logaddress_add_http`, `logaddress_add`, `logaddress_delall`, `logaddress_delall_http`, `sv_logsecret` | the event sink: a mode that redirected it would silence the match |
| `sv_downloadurl` | the image's, so a client downloads what the image serves |

## The `matchzy` flow

MatchZy 0.8.15 has no in-process forwards: its "events & forwards" are one HTTP remote log
(`matchzy_remote_log_url`, one custom header, no retry, no dedup) and nothing else — traced
in PRD-02 T9 against `references/MatchZy/`. So for a `matchzy` mode the split of decision 19
is:

- **The orchestrator composes the match config** (`apps/orchestrator/src/match-config/`,
  golden-tested): the request's teams and maps as MatchZy reads them, `skip_veto` (the
  platform ran the veto), the flat cvars the assignment also carries — because MatchZy's
  own `live.cfg` resets the round format and MatchZy re-applies its config's cvars after
  it. `matchid` is a positive 31-bit serial folded from the match id (MatchZy parses an
  `int`). No secret and no hostname in it.
- **The core plugin writes and loads it** when the map is up, adds
  `matchzy_hostname_format` (MatchZy rewrites the hostname from that cvar every round),
  and *then* points MatchZy's remote log at the orchestrator's door `POST /matchzy/log`
  with its own link token in the `x-ezpug-server-token` header — from its sidecar, after
  `matchzy_loadmatch`, never inside the file: the file is serialised into every round
  backup MatchZy writes.
- **The door translates once**: `going_live`, `round_end`, `map_result` → `map_end`,
  `series_end` become the vocabulary attributed to the same server as its link events.
  The round winner is the score delta between rounds (MatchZy's `winner.team` names the
  map *leader*), `winner.side` is read as `ct`/`t` or as the engine team number MatchZy
  actually writes, round numbers are the score sum (1-based), a tied map or series is
  `winner: null`. `series_start`, the veto trio, `demo_upload_ended` and
  `player_disconnect` are dropped: not facts of ours, or the core plugin's own.
- **What MatchZy cannot say, the core plugin observes** from the engine (`MatchZyFlow`):
  `match_paused` / `match_unpaused` off the gamerules (a tactical timeout names its team;
  the `pause` command over the link is MatchZy's `css_forcepause` and an admin pause),
  `side_swap` at a round start when the rostered team A stands on the other side (or, with
  nobody rostered, when the engine flagged the swap), and every round backup MatchZy writes
  as a `backup` frame plus `backup_written`, the token scrubbed out of it first.

Everything the plugin does here is on the SDK harness (`plugins/EZPug.Core.Tests`), and the
translation's fixtures are no longer guesses: `scripts/iron-match.mjs` played a `pug` with
bots on the dev node and the payloads a real MatchZy 0.8.15 sent are kept whole in
`packages/protocol/fixtures/recorded/real-pug-matchzy.json`; the door's fixtures are those
bytes, the cases they cannot produce edited from them, and the three events our flow never
produces read off MatchZy's own source. `apps/orchestrator/src/matchzy/fixtures.test.ts`
holds each file to saying which it is.

**One rule the recording added:** a `round_end` whose score has not moved since the last one
is a repeat and is dropped. MatchZy sent round 1 twice, a second apart, with two different
`reason` codes; a durable log that holds round 1 twice is one a client cannot count with.

### Writing a cvar a console will accept

Two things a real CS2 server taught this repo (PRD-02 T13), both of which look like nothing
until a whole match's events go missing:

- **`//` starts a comment in the engine's console**, even mid-line. A value containing one —
  a URL, above all — has to be quoted, or the line is cut short: `matchzy_remote_log_url
  http://host/path` reaches the plugin as the single argument `http`. The core plugin quotes
  every console value it writes (`CounterStrikeWorld.SetCvar`, `MatchZyRemoteLog`).
- **A manifest's boolean has to be spelled the way its cvar's owner parses it.** MatchZy
  declares `matchzy_enable_tech_pause` as a `FakeConVar<bool>`, and the *engine* parses that
  one: `true` is refused (`String 'true' can't be converted to Boolean`) and `1` is not. Its
  other switches are `[ConsoleCommand]` handlers that use `bool.TryParse`, where `true` and
  `false` are right and `1` is silently a no-op. There is no rule to infer — read the
  vendor's declaration, then check the server's console output on the first boot.

## A vendored plugin's own config file

MatchZy takes its match as a document. So does cs2-retakes, and so will the WeaponPaints
fork — a community plugin's settings are usually not cvars but a JSON file
CounterStrikeSharp hands it while it loads it. The assignment carries one document per
plugin folder in `pluginConfigs`, and the loader writes each where that plugin will look:

```
game/csgo/addons/counterstrikesharp/configs/plugins/<folder>/<folder>.json
```

Three things about it are load-bearing:

- **Before the first `css_plugins load`, never after.** CounterStrikeSharp reads the file
  once, inside `InitializeConfig`, on the way into the plugin's `Load`. A file that lands a
  frame later is a file nobody opens — which is why the loader writes every config at
  `assign`, before it enables anything, and not on the map hook with the cfg.
- **It is deliberately partial.** The plugin deserialises the document into its own config
  class, whose every property carries the vendor's default, so a key the orchestrator does
  not write is a key that keeps the value the plugin shipped with. `retakes` writes four
  (`match-config/retakes.ts`): the head count from `slots`, open join from
  `slots.openJoin`, the plugin's fallback allocation off because the vendored allocator
  does it, and both queue priority flags emptied — a `@css/vip` entry would make a
  CounterStrikeSharp admin file decide who keeps a slot, and EZPug has one permission
  mechanism.
- **The mode does not carry it.** There is no `pluginConfigs` in a manifest and there will
  not be one: the file belongs to the *plugin*, the orchestrator derives it from the
  manifest, and a client never sees it. What a manifest's `cvars` are for is the handful of
  console values that must beat what the vendor's own cfg does at map start —
  `gamemodes/retakes/cfg/ezpug/retakes.cfg` explains why that is the manifest's job and not
  the cfg's.

A folder name that is not a plain folder name is refused and warned about rather than
written: it is the one place a frame's key becomes a path. A `<folder>.toml` beside the
json wins inside CounterStrikeSharp, so the loader warns when it finds one instead of
letting the assignment be silently ignored.

## The generic flow

A `matchzy` mode has MatchZy. A `plugin` or `none` mode has nobody — a vendored community
plugin speaks its own language and a config-only mode speaks none at all — so the SDK
reads the flow off the engine and emits it through the runtime (`GenericFlow`, PRD-02 T22).
It is in every server, because it lives in `EZPug.Sdk` and the core plugin's runtime owns
one; a mode does not enable it and a `config` mode has nothing to enable it *with*.

| Event | Read from |
| ----- | --------- |
| `going_live` | the first round start outside warmup. "After warmup" is the only start a stock server gives: `mp_warmup_end`, or the warmup running out, restarts the game and the round after it is round 1 |
| `round_start` | every round start after that, with the score so far |
| `round_end` | the engine's round-end event: the winning side, why it won (`elimination`, `bomb_exploded`, `bomb_defused`, `time_expired`), and the two team scores as `cs_gamerules` keeps them |
| `side_swap` | the gamerules flagging a swap at the next round reset (`mp_halftime`), polled every 250 ms because the flag is transient — and at a new map of a series, on the ends its plan named |
| `map_end` | the win panel (`cs_win_panel_match`), the engine's own full stop, whatever decided the map — `mp_maxrounds`, a clinch or `mp_timelimit` |
| `series_end` | the same win panel, when the map that ended was the last one the request planned |

**Why `side_swap` is not optional.** CS2 swaps the team *scores* along with the players at
halftime, so a score read after the swap is in the new sides' order; without the swap
crossing the link, every round from halftime on lands on the wrong team. The emitter never
speaks during warmup, never before its map is up, never for a `matchzy` flow, and never
for a mode whose class says `OwnsFlow` — a mode that knows better is always right.

**It emits no pause.** Nothing pauses a stock server but an admin, and answering that
command is the mode's job.

## What the tier allows

| Rule | Because |
| ---- | ------- |
| a `config` mode has `plugins: []` and `flow` is not `plugin` | there is no plugin to enable or to own the flow |
| a `plugin` or `sdk` mode names at least one plugin | the mode runs on it |
| only an `sdk` mode has `commands` or a `widget` | the SDK relays taps; a community plugin has no seam for them |
| `capabilities.playerCommands` ⇔ `commands` non-empty; `capabilities.widget` ⇔ `widget` present; `widget` ⇒ `playerCommands` | a capability is a claim about a block that exists |
| `capabilities.backups` needs `flow` other than `none` | a backup restores into a match someone is running |
| an allow-list names at least one map | say `"any"` instead of an empty list |
| `ranked` is `false` | see above |

## How the platform renders one

From `GET /v1/gamemodes`, cached (PRD-09 T6):

- **The picker card**: `title[locale]` as the headline, `description[locale]` as the copy, a
  tier badge from `tier`, the shape from `slots` (`5v5`, `up to 12, free for all`, `open
  join`), "records a demo" when `records === 'demo'`, "has a phone widget" when
  `capabilities.widget`.
- **The room's team sizes** follow `slots.teamSize` and `slots.teams`; an open-join mode
  allows an empty roster.
- **The map picker** is filtered by `maps`: everything the platform's pool offers for
  `"any"`, the intersection for an allow-list.
- **The match page** shows the gamemode beside the context badge; the widget mounts for
  `capabilities.widget` modes; the live radar is offered for `capabilities.positions`.
- `pug` is preselected; the queue and tournaments are fixed to it. `ranked` is never read.

Every string a person sees comes from the manifest's `{ de, en }` objects through the
platform's locale layer; nothing is translated on the platform's side.

## The widget host

Decision 17: an `sdk` mode ships a built web component (`widget.entry`, produced by this
repo's `gamemode-kit` in PRD-02); the orchestrator serves it as an HTML document; the
platform mounts that document in an `iframe` with `sandbox="allow-scripts"` and no
same-origin, and injects what `widget.needs` lists. The widget then opens its own socket to
the orchestrator with the player token; taps become player commands; gameplay traffic never
touches the platform.

The transport is a `postMessage` handshake at protocol `1`, `WidgetHostMessage` in the
package. A URL fragment would put the player token into browser history and referrers; a
query string would put it into the orchestrator's logs.

1. The widget's script runs and posts `{ type: 'ezpug.widget.ready', protocol: 1 }` to its
   parent.
2. The host answers `{ type: 'ezpug.widget.init', protocol: 1, orchestratorUrl, matchId,
   locale, tokens, playerToken }`. `tokens` is the platform's design tokens as CSS custom
   properties (`{ '--signal-primary': '#…' }`, from `signal.css`); the widget sets them on
   its root. `playerToken` is `null` for a viewer who may watch but not tap (a spectator, an
   unrostered viewer); a widget that `needs` it shows its own "watching only" state.
3. The host posts `{ type: 'ezpug.widget.tokens', tokens }` whenever the theme changes.
4. The widget posts `{ type: 'ezpug.widget.size', height }` whenever its content height
   changes; the host sizes the frame to it.
5. The widget posts `{ type: 'ezpug.widget.error', message }` when the host should show
   something instead of it.

Both sides check `event.origin`: the widget accepts messages only from the origin it was
mounted from (the host passes nothing before `init`, so the widget learns it from the first
message and pins it), the host only from the orchestrator's origin. A host and a widget on
different `protocol` majors do not talk; the host shows its error state.

## Authoring the next one

1. `mkdir gamemodes/<id>` and write `manifest.json` against the field table; pick the tier
   first, it decides the rest.
2. Add the id to `SHIPPED_GAMEMODE_IDS` and the import in
   `packages/match-api/src/gamemodes/index.ts`; the test insists the directory list and the
   id list agree.
3. `pnpm verify`. The manifest is now in the catalog the fake serves and in the JSON Schema
   the C# side generates from.
4. What the manifest names — the plugin folder, the cfg, the widget bundle — is built in
   the plugin and gamemode work of PRD-02; a manifest may lead its implementation, never
   trail it.
