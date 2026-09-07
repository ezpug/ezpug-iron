# The SDK

How a gamemode is written for EZPug Iron: `EZPug.Sdk` (C#, CounterStrikeSharp behind it,
never in front of it) and `EZPug.Sdk.Testing`, the harness that plays a mode under xunit
without CS2. Read `docs/gamemodes.md` first for what a manifest says; this is the code
beside the manifest. Decisions 5, 16, 17 and 19 in `docs/decisions.md` are the why.

## The shape

A gamemode is **a class over the SDK and a manifest beside it**. The class derives from
`Gamemode`, overrides the hooks it needs and emits vocabulary events; the manifest
(`gamemodes/<id>/manifest.json`) says which plugins to enable, which cfg to exec, which
verbs a phone may fire and what they cost. The SDK owns everything two modes would both
write:

| Seam | What it is | Production | Test |
| ---- | ---------- | ---------- | ---- |
| `IGameWorld` | players (SteamID64, slot, team, alive, position, scoreboard rating), say/print/center/HUD, give/strip, respawn, health/armor/speed, the scoreboard's rating, exec cfg, cvars, changelevel and workshop maps, and every hook the engine raises (connect, spawn, death, round, bomb, chat, map started, map ended on the win panel, tick) | the core plugin's CounterStrikeSharp adapter (PRD-02 T8) | `FakeGameWorld` |
| `IPlatformLink` | emit an event, report state, send a backup or a console tail; receive assignment, commands, player commands, profiles through `IPlatformLinkHandler` | `LinkClient` — one outbound WebSocket to `/link` | `FakePlatformLink` |
| `IClock` | monotonic milliseconds and timers; the only time a mode may read | `SystemClock` for the link's threads; `GameThreadClock` for a mode — the core plugin fires its timers from the engine's tick | `FakeClock` |
| `GamemodeRuntime` | the link's handler and the world's listener, routing both to the attached mode; stamps the per-match `seq`; emits the plumbing and gameplay events once | owned by the core plugin | owned by `GamemodeTestHost` |

A mode never sees a CounterStrikeSharp type. When a mode needs a verb the seam lacks, the
seam grows once — in `IGameWorld`, in `FakeGameWorld`, with a test — rather than the mode
reaching around it.

## A mode in fifty lines

`plugins/EZPug.Sdk.Tests/Modes/PowerupDemo.cs`, the mode the harness test plays. It
implements the shipped `powerup-dm` manifest: deathmatch by cfg, one power-up per life,
claimed from the phone or with `!powerup speed` in chat. **The mode that ships is
`plugins/EZPug.PowerupDm/`** (PRD-02 T26) — the same shape with the peek's timer, the HUD
countdown and its own resx pair; this is the fifty lines, not the product.

```csharp
public sealed class PowerupDemo : Gamemode
{
    private sealed class Life { public string? Powerup; }
    private PlayerState<Life>? _lives;

    public override string Id => "powerup-dm";

    protected override Localizer CreateLocalizer() =>
        Localizer.FromEmbedded(GetType().Assembly, "EZPug.Sdk.Tests.Modes.PowerupDemo");

    public override void OnAssigned(Assignment assignment) => _lives = PlayerState(_ => new Life());

    public override void OnPlayerJoined(IGamePlayer player) => Say(player, "powerup.welcome");

    public override void OnPlayerSpawned(IGamePlayer player)
    {
        _lives![player].Powerup = null;
        World.SetSpeed(player, 1f);
    }

    public override PlayerCommandOutcome OnPlayerCommand(IGamePlayer player, string command, JsonObject? args)
    {
        if (!player.IsAlive) return new PlayerCommandOutcome.NotAlive();
        var kind = args?["kind"]?.GetValue<string>() ?? "speed";
        switch (kind)
        {
            case "armor": World.SetArmor(player, 100); break;
            case "radar_peek": PushWidget(player, "radar_peek", new { expiresInMs = 5_000 }); break;
            default: World.SetSpeed(player, 1.4f); break;
        }
        _lives![player].Powerup = kind;
        Say(player, "powerup.landed", Lines(player)[$"powerup.kind.{kind}"]);
        EmitPluginEvent("powerup_claimed", new { steamId64 = player.SteamId64.ToString(), kind });
        return PlayerCommandOutcome.Ok;
    }

    public override void OnPlayerDied(PlayerDeath death) => After(2_000, () => World.Respawn(death.Victim));

    public override void OnEnd(string? reason) => SayAll("powerup.bye");
}
```

What the mode did *not* write: the verb's one charge per life and its `kind` enum
(the manifest declares them, the SDK refuses a second tap with `no_charges` and a bad
`kind` with `invalid_args` before `OnPlayerCommand` runs), the `player_connected`,
`player_death` and `chat_*` events (the runtime emits them from the world's hooks), the
per-match `seq` on every event, the German/English switch per player, the timer cleanup at
release, the link.

Beside it, two resx files with the same keys — `PowerupDemo.de.resx` and
`PowerupDemo.en.resx` — embedded as raw XML:

```xml
<ItemGroup>
  <EmbeddedResource Remove="Modes\*.resx" />
  <EmbeddedResource Include="Modes\*.resx" Type="Non-Resx" WithCulture="false"
                    LogicalName="My.Mode.%(Filename)%(Extension)" />
</ItemGroup>
```

`Type="Non-Resx"` keeps MSBuild's resgen off them: the SDK parses the resx itself, so no
satellite assembly has to be found in a culture folder beside a hot-loaded plugin. German
is the master file and the default locale; a key missing in one language fails the SDK's
own test for its lines, and a mode should assert the same for its pair.

## The hooks

| Hook | When | Notes |
| ---- | ---- | ----- |
| `OnAssigned(Assignment)` | the orchestrator assigned a match | the host has enabled the plugins and asked for the map, which is still loading; the cfg and cvars land when the map is up, before `OnStart`. `Assignment` holds the manifest, the map plan, the rules, the roster with profiles and loadouts, warmup lines, branding, the demo URL, and `Restore` when the match resumes here |
| `OnStart()` | the first map is up; the host's cfg and cvars are applied; `server_ready` was emitted | go |
| `OnPlayerJoined/Left(IGamePlayer)` | a connect / disconnect, bots included | the vocabulary event is emitted for humans by the runtime |
| `OnPlayerSpawned(IGamePlayer)` | a spawn | `life` charges refill here |
| `OnPlayerDied(PlayerDeath)` | a death | `player_death` is emitted by the runtime |
| `OnRoundStart(long)` / `OnRoundEnd(RoundEnd)` | the engine's round events | the round number is 1-based and in `Match.RoundNumber`; `round` charges refill on start |
| `OnChat(ChatLine)` | a line that was not a declared verb | `chat_message` / `chat_command` are emitted by the runtime when the manifest's `chat` capability is on |
| `OnPlayerCommand(player, command, args)` | a declared verb, after the SDK's checks; from the phone, or from chat — where the words after `!verb` become the args schema's first declared property (`ArgsValidator.FromChat`), so both doors hand the mode the same object | return `Ok` to spend the charge and start the cooldown; `Refused(message)` or `NotAlive` cost nothing |
| `OnProfile(RosterEntry)` | a profile pushed (open join, a refreshed rating) | already in `Assignment.Profiles` |
| `OnCommand(LinkCommand)` | a Match API command the runtime does not answer itself | `announce`, `kick`, `rcon`, `profile` are the runtime's; `pause`, `unpause`, `restart_round`, `force_end`, `restore`, `reroll` are the mode's or the host's (`CommandHook`). Return `CommandAnswer.Deferred` and call `Link.AnswerCommand` later for work that waits on the engine; the orchestrator's deadline is fifteen seconds |
| `OnTick()` | every engine frame while assigned | |
| `OnDrain()` | finish what you have, take nothing new | |
| `OnEnd(reason)` | `release` | after it returns, the mode's timers are cancelled and its `PlayerState`s cleared |

Helpers on the base: `World`, `Link`, `Clock`, `Localizer`, `Facts`, `Match`,
`Assignment`, `Commands`; `Emit`, `EmitPluginEvent`, `PushWidget`; `Lines(player)`, `Say`,
`SayAll`, `PrintCenter` (all localized per player); `PlayerState<T>(factory)`; `After`,
`Every`.

### Branding: the hostname, the voice, the card

A mode writes nothing for this either. The runtime's `Branding` (`Runtime.Brand`) turns
the request's `branding` block and the manifest into the four places a player sees the
match (decision 22; in-world banners need a Workshop addon and are a later round):

| Where | What |
| ----- | ---- |
| the server browser | `branding.hostname` when the request named one, else `EZPug · <event> · <mode> · <Map>` — the event only where `branding.eventName` was given. Clamped to 63 characters. The loader sets it on `assign` and writes the same string into `matchzy_hostname_format`, because MatchZy rewrites `hostname` from that cvar every round |
| every line the server says | `[EZPug] …` — the event's name in place of `EZPug` where there is one, green, in front of the text. `Say`/`SayAll` in a mode, the rating connect line and a refused player command all go through it, so the server has one voice |
| a team's name in chat | `Brand.TeamName(MatchTeam.TeamA)` — the roster's name in the colour of the side that team is on right now (CT blue, T gold), which a `side_swap` moves with the players |
| the middle of the screen | a four-line card two seconds after a player is fully connected: the event or `EZPug`, this gamemode's title from its manifest, the one thing to do now, and `ezpug.com` |

The card and the team line are bilingual, per player, German by default, like everything a
human reads (`branding.team`, `branding.card.ready`, `branding.card.widget`,
`branding.card.enjoy` in the SDK's catalog). What the card asks of a player follows the
manifest: `.ready` for a `matchzy` flow, the phone for a mode with player commands or a
widget, and otherwise nothing but "have fun". A free-for-all (`slots.teams: 1`) is told no
team, because it has none; somebody who joined open is told none either, until a `profile`
arrives — and a bot is told nothing at all.

Two things deliberately do **not** carry the prefix: a client's `announce` command and
`ezpug_announce` on the console. Those are the platform's own words relayed to the server,
and the platform brands them itself.

A name that arrives from outside — an event, a team, a hostname — is passed through
`ChatColor.Strip` before it is pasted into one of ours, and the card's markup is escaped,
so nobody colours the rest of a chat line or breaks the panel by what they called their
team. `ChatColor` holds the engine's palette as code points; the card is HTML, because
that is what the centre panel reads.

### EZ Rating on the scoreboard

A mode writes nothing for this. When the manifest's `scoreboardRating` capability is on,
the runtime's `RatingBoard` draws the roster's `rating` where Premier draws its own
number — `SetScoreboardRating(player, rating)` on the world, which is
`m_iCompetitiveRanking` with `m_iCompetitiveRankType` set to Premier's `11` on the real
thing (decision 21). No clan tag, no chat spam, no HUD card: the scoreboard cell and one
connect line, and that is all EZ Rating gets in-game.

The rating is the platform's and is only relayed: it arrives in the assignment's profiles
or in a later `profile` push, and a player nobody has a profile for is left alone rather
than shown a zero. The engine forgets the fields across a level change, a reconnect and a
round, so the numbers are written again on the assignment, on a connect, on a profile, when
the map is ready and at every round start. `release` clears them.

The **connect line** is bilingual (`rating.connect`, `rating.connect.rank`,
`rating.connect.unrated` in the SDK's catalog, German default) and is said **once per
connection**, at the first moment there is something to say: on connect for a rostered
player, on their `profile` for somebody who joined open and was a stranger until it
arrived. Bots are drawn and never talked to. A roster entry carries no streak, so the line
names the rating and the rank and nothing else.

**Two things the engine decides, both measured on the dev node** (T27):

- The fields are locked unless CounterStrikeSharp's `FollowCS2ServerGuidelines` is off
  (`Cannot set or get 'CCSPlayerController::m_iCompetitiveRanking'`). The image turns it
  off; `docs/operations.md` carries the reason and the risk. Where it is on, the write is
  refused, warned about once and drawn nowhere — never thrown, because a throw inside a
  link command eats the answer the orchestrator is waiting for.
- **A bot's number is the engine's, not ours.** A bot takes the rank *type* and keeps it,
  and reads its ranking back as `0` however often it is written. So a bots run proves the
  path — profile pushed, link crossed, controller written, read back — and proves nothing
  about the cell a human sees; that half is a human with a client, and is written as
  visual where it is claimed.

Reading it back: `IGamePlayer.ScoreboardRating` is the engine's own value, not what was
asked for, and `ezpug_status`'s `scoreboard:` line is that read. `ezpug_status` answers on
the *server console*, not to whoever ran it, so on a node its RCON reply is empty and the
report also goes into the plugin's console buffer — `GET /v1/fleet/servers/:id/console` is
the door that hands it back from anywhere.

### Skins over the link — `ILoadoutSource`

A mode writes nothing for this either. The platform owns loadouts (decision 20): a roster
entry carries one (`RosterEntry.Loadout`, the Match API's mirror of cs2-WeaponPaints' six
tables), a `profile` push refreshes one, and the `Assignment` holds them all. The core
plugin publishes `EZPug.Sdk.Hosting.ILoadoutSource` — two members, `LoadoutOf(steamId64)`
and a `LoadoutChanged` event — through the same shared-plugin capability the gamemode host
uses (`LoadoutSource`, `ezpug:loadouts`), and the data-layer fork of WeaponPaints
(`plugins/vendor/WeaponPaints/`, its `PATCHES.md`) reads a player's loadout through it on
connect, on `!wp` and when `LoadoutChanged` names them — where upstream ran six `SELECT`s
against a MySQL server. There is no database in the image and none on the internet.

What the core hands out is a lookup in the assignment, never a copy: `null` when no match
is assigned, nobody knows the player, or their profile has no loadout — and `null` means
default items, never an error, because skins may never touch match flow (the platform's
Skins.md). The orchestrator enables the `WeaponPaints` folder only when a roster entry
carries a loadout and the image has the plugin (`link/assign.ts`). Every hand-off is a
`skins:` line on the core's console, which is the one place it can be seen on a bots run:
a bot is never dressed — upstream checks `IsBot` on every apply path and this repo does not
patch what the plugin does with a loadout — so the hardware proof is the seam, and the
pixels are a human's (T36).

The runtime raises `Profiled` for the host after `Assignment.Push`, so what a hook reads
back through `Assignment.ProfileOf` is the pushed entry; the fork re-reads the player's
rows then and forces nothing on them mid-round — the platform's page says "applies on
your next connect, or type `!wp`", and that stays true.

### `PushWidget` — a picture for one phone

`PushWidget(player, name, data)` sends a **push**: a named, mode-shaped payload that
reaches that one player's open widget and nobody else's, and is then forgotten — never
sequenced, never acked, never stored in the match's log, never replayed to a widget that
reconnects (`@ezpug/match-api`'s `WidgetPushFrame`, 0.7.0; the link's `widget_push`
frame). It is the door for the facts a match must *not* keep: `powerup-dm`'s `radar_peek`
pushes everybody's coordinates ten times over five seconds, and no position is ever
written down (CLAUDE.md). A fact that has to survive is an event, not a push; a push with
no widget listening is dropped, which is the normal case.

The widget's half is `link.onPush(handler)` in `@ezpug/gamemode-kit`. Both halves ship
together in `gamemodes/<id>/`, which is why the contract does not read `data`.

## The event model

`Facts` builds vocabulary events with the parts every one carries — `matchId`, `source`,
the map and round numbers — filled from the runtime's `MatchContext`:
`Facts.RoundEnd(winner, side, condition, score)`, `Facts.GoingLive(map)`,
`Facts.MapEnd(score, winner)`, `Facts.SeriesEnd(…)`, `Facts.SideSwap(teamA)`,
`Facts.PositionTick(players)`, `Facts.Plugin(name, data)` and the rest. The generated
records in `EZPug.Sdk.Protocol` are the wire truth (regenerated from
`packages/protocol`, never hand-written); `Facts` only saves the typing.

`Facts.Player(player)` turns an engine team into the vocabulary's `team_a` / `team_b` /
`spec`: the roster decides for a rostered player, the sides in effect (from the map plan,
swapped by a `side_swap`) for an open-join one, `team_a` for everyone in a one-team mode.

**Who emits what.** The runtime emits the plumbing and gameplay events once from the
world's hooks: `server_ready`, `player_connected`, `player_disconnected`, `player_death`,
`bomb_*`, `chat_message`, `chat_command`. Match-flow events — `going_live`, `round_start`,
`round_end`, `side_swap`, `map_end`, `series_end`, the pauses — belong to the flow owner
the manifest names (decision 19): for `flow: matchzy` MatchZy's HTTP remote log, translated
by the orchestrator (MatchZy 0.8.15 has no forwards), with the pauses, side swaps and
backups MatchZy cannot say observed by the core plugin (`plugins/README.md`); the SDK's
generic flow emitter for `flow: plugin | none` (PRD-02 T22); or the mode itself when it
knows better. Emitting a flow event through the runtime advances
the context: `going_live` sets `Live`, `map_end` bumps the map number and resets the
round, `side_swap` swaps the sides.

Every event a mode emits is stamped with the per-match `seq` hint (position ticks are
not: they are ephemeral) and the link gives it the per-server link `seq`.

**Rounds and maps.** The runtime numbers rounds from the engine's own count when the
world exposes one (`IGameWorld.Rules`, the `cs_gamerules` snapshot: warmup, rounds played,
pauses and timeouts, a pending side switch) — warmup and a knife round never count,
`mp_restartgame` resets it — and by itself when it does not (the harness, unless a test
sets `FakeGameWorld.Rules`). A second map while a `matchzy` flow is assigned is the series'
next map: the map number advances, the round resets; a mode that owns its flow advances
the map by emitting `map_end`.

**The generic flow.** A `flow: plugin | none` mode gets `going_live`, `round_start`,
`round_end`, `side_swap`, `map_end` and `series_end` for nothing: `GenericFlow` reads them
off the engine through `IGameWorld` and emits them through the runtime, which is how
`flying-scoutsman` — a manifest, a cfg and no class anywhere — tells a complete match.
`going_live` is the first round start outside warmup; the score comes from the round-end
event's two team scores, put in team order by the sides in effect; `side_swap` follows the
gamerules' halftime flag (polled every `GenericFlow.PollIntervalMs`) and the map plan's
ends at a new map; `map_end` is the win panel and `series_end` the win panel of the last
map planned. Override `OwnsFlow => true` on a mode that emits these itself and the emitter
falls silent for it — everything else the runtime does stays. `docs/gamemodes.md` has the
table; `GenericFlowTests` plays a whole map of it on the harness.

**Position ticks** are the runtime's too: every `GamemodeRuntime.PositionTickIntervalMs`
(100 ms) while a match is assigned, the manifest's `positions` capability is on and the
link is up, the alive players' positions go out as one `position_tick` — unsequenced, and
never buffered for a link that is down, so an outage does not come back as a flood. The
harness keeps them apart from the story (`FakePlatformLink.Ticks`, not `Events`), so a
test's exact event list stays exact.

**Bots** have no SteamID64, and the vocabulary insists on one: `BotIdentity.SteamId64Of(slot)`
names a bot `90000000000000000 + slot`, stable for its connection and outside anything Steam
issues; `BotIdentity.IsBot(id)` reads it back. The core plugin applies it, the harness may
(`World.Connect(BotIdentity.SteamId64Of(1), "Bot Cliff", bot: true)`), and a bot's death is a
real `player_death`.

## Player commands

The manifest's `commands` are enforced in the SDK and never trusted to the phone
(decision 17). A tap — from the widget's socket, relayed as a `player_command` frame, or
`!verb` in chat — goes through `CommandTable` in the order the refusal set lists:

1. the verb exists in the manifest — else `unknown_command`;
2. the args fit the verb's JSON Schema (`ArgsValidator`: `type`, `properties`,
   `required`, `additionalProperties`, `enum`, `const`, `minimum`/`maximum`,
   `minLength`/`maxLength`, `items`, `minItems`/`maxItems`) — else `invalid_args`;
3. the cooldown has passed — else `cooldown` with `cooldownMs` left;
4. a charge is left in the period — else `no_charges`;
5. the mode's `OnPlayerCommand` — `NotAlive` and `Refused(message)` come back as
   `not_alive` and `refused`.

Only an applied tap spends the charge and starts the cooldown. Charges refill when their
period turns: `life` on the player's spawn, `round` on round start, `map` on map start
(and on a `map_end` emitted through the runtime), `match` never. Every refusal message is
in the player's locale from their profile, German when nobody knows them. A player who
leaves is forgotten; a release clears the table.

## The link

`LinkClient` is decision 5 in one class: one `ClientWebSocket` to the orchestrator's
`/link`, and the behaviour the TypeScript fake server pins in
`packages/protocol/fixtures/link/*.json` — `EZPug.Sdk.Tests` replays every one of those
files against it, frame for frame, byte for byte.

- **Hello first.** The token from the sidecar, the versions, the capabilities, the plugin
  folders in the image, hostname, map, state, the match held (a reconnect mid-match says
  so) and `lastSeq`. Nothing else is sent before `welcome`.
- **Every event is buffered until acked.** `IEventBuffer` hands out the per-server link
  `seq`; `FileEventBuffer` keeps it on disk (`events.jsonl` with a `{"lastSeq":n}` header,
  `acked.log`, compaction past 500 acks) so a restarted plugin continues the count and
  resends what the orchestrator never acknowledged; `MemoryEventBuffer` is the harness's.
  On `welcome`, everything at or below `ackedSeq` is dropped and the rest resent in order
  in batches of `EVENTS_BATCH_MAX`. At-least-once here, dedup on the orchestrator's side.
- **Answers carry the correlation id they came with**: `command_result`, a `console`
  frame for the `console` command, `player_command_result`. `assign`, `release` and
  `drain` are answered by the runtime with a `state`.
- **Heartbeats** every `welcome.heartbeatIntervalMs`, on the clock; `uptimeMs` is the
  clock's monotonic count, never wall time.
- **Reconnect with capped exponential backoff** (1 s doubling to 30 s, reset by a
  welcome) after a lost socket, a refused dial, or a close the protocol calls a hiccup
  (1000, 1001, 1005, 1006, 1011, `replaced`, `shuttingDown`). A close that is a decision —
  `unauthorized`, `protocolMismatch`, `malformed`, `revoked` — stops the loop and reaches
  the handler as fatal. Nothing is logged that a token or a frame could be in.
- **The newest backup is kept** until a welcomed socket takes it, so a round backup
  written during a reconnect still reaches the orchestrator.
- **Threads.** The socket is read and written on the thread pool; `Emit` and the other
  outbound verbs may be called from anywhere; inbound frames queue until `Pump()` delivers
  them to the handler on the caller's thread — the game thread in production, so a mode
  never locks. The runtime pumps on the world's tick.

**The sidecar.** `Sidecar.Load` reads `EZPUG_IRON_URL` + `EZPUG_SERVER_TOKEN`
(+ `EZPUG_LINK_BUFFER_DIR`) from the environment — a node's container, the dev image — or
`ezpug.json` (`{ "url", "token", "bufferDir"? }`), the file the Dathost provider uploads.
The environment wins when both exist. The URL may be the orchestrator's base
(`https://gs.ezpug.com` → `wss://gs.ezpug.com/link`). `ToString()` redacts the token.

## Testing a mode

`GamemodeTestHost` wires `FakeGameWorld`, `FakePlatformLink`, a `FakeClock` and the real
runtime around your mode. The harness test for the sample above
(`GamemodeHarnessTests.cs`) is the pattern:

```csharp
using var host = new GamemodeTestHost(new PowerupDemo());
var manifest = GamemodeTestHost.ManifestFrom(File.ReadAllText("gamemodes/powerup-dm/manifest.json"));
host.Start(GamemodeTestHost.AssignmentFor(manifest, teamA: [GamemodeTestHost.Player(tk, "tk", Locale.De)]));

var player = host.World.Connect(tk, "tk", PlayerTeam.Terrorist);
host.World.Spawn(player);
var result = host.Link.PlayerCommand(tk, "powerup", args);   // applied, chargesLeft 0
host.World.Kill(player, killer: null);
host.World.Elapse(2_000);                                     // the respawn timer fires
Assert.Equal(["server_ready", "player_connected", "plugin_event", "player_death"], host.Link.EventTypes);
```

The world records every verb the mode called (`World.Actions`, `Said`, `Broadcasts`);
the link records every event, state and answer; the clock only moves when the test says.
`Elapse` advances the clock and fires one frame. Push the orchestrator's side with
`Link.Assign`, `Link.Command`, `Link.PlayerCommand`, `Link.PushProfile`, `Link.Release`.
Nothing here needs CS2, Steam or a network, and a full match runs in milliseconds.

## The host: `EZPug.Core` and the runtime's host hooks

`EZPug.Core` — the plugin every server runs (PRD-02 T8, `plugins/README.md`) — provides
`IGameWorld` and the game-thread `IClock` over CounterStrikeSharp, reads the sidecar, runs
the `LinkClient`, owns the one `GamemodeRuntime`, and is the gamemode loader. The loader
hangs off three host events on the runtime, in the order a match goes through them:

| Hook | When | What the core does there |
| ---- | ---- | ------------------------ |
| `Assigned(Assignment)` | `assign` arrived, before the mode's `OnAssigned` | hostname, `css_plugins load` for each plugin the assignment names, `Runtime.ExpectMapChange()` (below) and then `changelevel` / `host_workshop_map` to the first map — or to the backup's map when `Assignment.Restore` is set (the runtime's `Match.MapNumber` / `RoundNumber` then start where the lost server left off) |
| `MapLoaded(Assignment, map)` | the map is up, before `server_ready` is emitted and before `OnStart` | exec the cfg files in order, then — a beat later, in a console frame of its own (`Runtime.SettleThen`, below) — set the flat cvars, write and `matchzy_loadmatch` the match config for a `matchzy` flow (once per assignment; a later map is the series' next), point MatchZy's remote log at the orchestrator, and for a restore write the backup where MatchZy looks and `matchzy_loadbackup` it (`backup_restored` is emitted as a `plugin_event`) |
| `Released(reason)` | after the mode's `OnEnd`, its timers and state cleared | `css_plugins unload` in reverse, the lobby map, then the runtime says `idle` |
| `Profiled(RosterEntry)` | a `profile` frame landed and `Assignment.Profiles` already holds it, before the mode's `OnProfile` | tell the skins layer to re-read that player (below) |

A mode never needs these; a second host (the harness is one) hooks the same ones.

**A host may ask for a beat.** From inside `MapLoaded`, `Runtime.SettleThen(delayMs, rest)`
runs `rest` that much clock time later and holds `server_ready` — and the mode's `OnStart`
— until it has, so "the map is up" still means "and configured". The core plugin uses it
for the one reason it exists: the engine reconciles a cvar's *effects* once at the end of
the console frame it was set in, against the value it held before that frame, so a value
the mode's cfg sets and the request sets back is not two changes but none — a `bot_quota`
beside a `bot_kick` leaves an empty server (PRD-02 T22a, measured on the dev node). The cfg
therefore gets the first frame and everything the assignment asks for the next. A release,
a reassignment or the next map start drops a beat still pending, and nothing is said for a
match the server no longer holds.

**A host that changes level says so first.** A world does not have to announce a map the
instant the engine starts it — the core plugin waits `CounterStrikeWorld.MapReadyDelayMs`
(one second) so the map is worth talking to — and on a container that has only just booted
the `assign` lands inside that second. The boot map's news then arrives with an assignment
in hand, and without a word from the host the runtime takes it for the match's map: it
execs the cfg on it and says `server_ready` for a map that was never the match's, a second
before the real one (PRD-02 T22c, seen twice on the dev node). So a host that is about to
ask the engine for a level change calls `Runtime.ExpectMapChange()` first, from inside
`Assigned`. Every `MapStart` the engine *began* before that call is the old map's and is
dropped with a log line; the first one that began after it is the match's, and the wait is
over. That is why `MapStart` carries `StartedAtMs` beside `Map` — the two instants are not
the same one, and only the earlier can tell the maps apart. A host that never changes level
never calls it and nothing waits.

**Demos** (`DemoFlow`, PRD-02 T21) hang off the same runtime and off one world hook,
`MapEnded` — the engine's match win panel, the one end-of-map signal every flow shares.
For a `records: demo` gamemode:

- MatchZy runs `tv_record` for its own flow; for any other flow the SDK runs it itself at
  `MapLoaded` and `tv_stoprecord` one GOTV delay (`tv_delay`) after the win panel, because
  GOTV records the *delayed* broadcast and stopping on the panel would cut the last rounds
  off the file.
- **The upload is always the core plugin's** (decision 10): MatchZy's own uploader POSTs a
  multipart form, which a presigned PUT will not take. Nothing says when a `.dem` is
  finished, so from the win panel on the newest one is watched until its length has not
  moved for a settle window, then `DemoUploader` hashes it, streams it at
  `Assignment.DemoUploadUrl` and retries on the injected clock. What landed is announced as
  `Facts.DemoAvailable(filename, sizeBytes, sha256, contentType)`; the hash is the
  orchestrator's cue to relay `demo.uploaded`. Without an upload URL the demo is still
  announced, hashless — it exists on this server and nowhere else.
- The transport is a seam (`IDemoTransport`); `FakeDemoTransport` in `EZPug.Sdk.Testing`
  records every attempt, so the retry loop is proven without a network.

**A gamemode plugin** is the mode plus a CounterStrikeSharp shell, and the shell is
written once in `EZPug.Sdk.Hosting`: derive from `GamemodePlugin`, name the module, return
the mode. It finds the core's runtime through `GamemodeHost` — a CounterStrikeSharp
`PluginCapability` the core publishes — on load (or once every plugin has loaded, if the
core came later) and attaches; a mode attached after the assignment hears `OnAssigned` at
once, and `OnStart` if the map is already up.

```csharp
public sealed class PowerupDmPlugin : GamemodePlugin
{
    public override string ModuleName => "EZPug.PowerupDm";
    public override string ModuleVersion => "0.1.0";
    protected override Gamemode CreateMode() => new PowerupDm();
}
```

The capability is keyed by a type in the SDK, which is why `EZPug.Sdk.dll` is installed
once under `addons/counterstrikesharp/shared/` and never beside a plugin — one assembly,
one type, one host. `plugins/README.md` draws the layout and says how to install by hand.
