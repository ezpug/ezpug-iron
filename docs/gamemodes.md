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
| `config` | `flying-scoutsman` | stock CS2 by cfg alone: no plugin, no match flow; the map runs until the client ends the match or the TTL does |
| `plugin` | `retakes`          | a vendored community plugin (B3none/cs2-retakes) under the core plugin: its own flow, its own map pool, events without a demo |
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
| `flow` | who owns match flow. `matchzy`: MatchZy runs ready-up, knife, live, the series, and its events are translated into the vocabulary once at the edge. `plugin`: the mode's plugin speaks `going_live`, `round_end`, `map_end`, `series_end` itself. `none`: nobody does; the match ends by `force_end`, `cancel` or the TTL |
| `records` | `demo`: a demo is recorded and uploaded to the request's `demoUploadUrl`, `demo.uploaded` follows, and every durable event flows. `events`: the durable events only. `none`: orchestration facts only; the game's events still stream live but nothing is promised durably. Positions and chat are never records |
| `ranked` | always `false`. The manifest states what the server records, never what counts |
| `maps` | `"any"` — the request plans whatever it likes, workshop maps included; the platform's map pool decides. Or an allow-list `{ catalog: [engine names], workshop: [published-file ids] }`; a request planning a map outside it is refused `map_not_allowed` at the door. A plugin that ships spawn files per map lists them; a mode built for one map lists one |
| `plugins` | folder names under `addons/counterstrikesharp/plugins/`, enabled in this order. Empty for a config mode, non-empty otherwise |
| `cfg` | files under the server's `cfg/`, exec'd in this order after the map loads and before the match's own rules are applied. A config mode's whole truth is its cfg |
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
| `backups` | round backups are written and `restore` works, so a crashed server is recovered mid-match. Needs a flow owner (`flow` is not `none`) |
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
