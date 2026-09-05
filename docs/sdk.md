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
| `IGameWorld` | players (SteamID64, slot, team, alive, position), say/print/center/HUD, give/strip, respawn, health/armor/speed, exec cfg, cvars, changelevel and workshop maps, and every hook the engine raises (connect, spawn, death, round, bomb, chat, map, tick) | the core plugin's CounterStrikeSharp adapter (PRD-02 T8) | `FakeGameWorld` |
| `IPlatformLink` | emit an event, report state, send a backup or a console tail; receive assignment, commands, player commands, profiles through `IPlatformLinkHandler` | `LinkClient` — one outbound WebSocket to `/link` | `FakePlatformLink` |
| `IClock` | monotonic milliseconds and timers; the only time a mode may read | `SystemClock` for the link's threads; the game-thread clock the core plugin builds on CounterStrikeSharp's timers for a mode | `FakeClock` |
| `GamemodeRuntime` | the link's handler and the world's listener, routing both to the attached mode; stamps the per-match `seq`; emits the plumbing and gameplay events once | owned by the core plugin | owned by `GamemodeTestHost` |

A mode never sees a CounterStrikeSharp type. When a mode needs a verb the seam lacks, the
seam grows once — in `IGameWorld`, in `FakeGameWorld`, with a test — rather than the mode
reaching around it.

## A mode in fifty lines

`plugins/EZPug.Sdk.Tests/Modes/PowerupDemo.cs`, the mode the harness test plays. It
implements the shipped `powerup-dm` manifest: deathmatch by cfg, one power-up per life,
claimed from the phone or with `!powerup` in chat.

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
        var kind = args?["kind"]?.GetValue<string>() ?? "haste";
        switch (kind)
        {
            case "haste": World.SetSpeed(player, 1.4f); break;
            case "armor": World.SetArmor(player, 100); break;
            default: World.SetHealth(player, 100); break;
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
| `OnAssigned(Assignment)` | the orchestrator assigned a match | plugins are enabled and cfg exec'd by the host first; the map may still be loading. `Assignment` holds the manifest, the map plan, the rules, the roster with profiles and loadouts, warmup lines, branding, the demo URL, and `Restore` when the match resumes here |
| `OnStart()` | the first map is up; `server_ready` was emitted | go |
| `OnPlayerJoined/Left(IGamePlayer)` | a connect / disconnect, bots included | the vocabulary event is emitted for humans by the runtime |
| `OnPlayerSpawned(IGamePlayer)` | a spawn | `life` charges refill here |
| `OnPlayerDied(PlayerDeath)` | a death | `player_death` is emitted by the runtime |
| `OnRoundStart(long)` / `OnRoundEnd(RoundEnd)` | the engine's round events | the round number is 1-based and in `Match.RoundNumber`; `round` charges refill on start |
| `OnChat(ChatLine)` | a line that was not a declared verb | `chat_message` / `chat_command` are emitted by the runtime when the manifest's `chat` capability is on |
| `OnPlayerCommand(player, command, args)` | a declared verb, after the SDK's checks | return `Ok` to spend the charge and start the cooldown; `Refused(message)` or `NotAlive` cost nothing |
| `OnProfile(RosterEntry)` | a profile pushed (open join, a refreshed rating) | already in `Assignment.Profiles` |
| `OnCommand(LinkCommand)` | a Match API command the runtime does not answer itself | `announce`, `kick`, `rcon`, `profile` are the runtime's; `pause`, `unpause`, `restart_round`, `force_end`, `restore`, `reroll` are the mode's or the host's (`CommandHook`). Return `CommandAnswer.Deferred` and call `Link.AnswerCommand` later for work that waits on the engine; the orchestrator's deadline is fifteen seconds |
| `OnTick()` | every engine frame while assigned | |
| `OnDrain()` | finish what you have, take nothing new | |
| `OnEnd(reason)` | `release` | after it returns, the mode's timers are cancelled and its `PlayerState`s cleared |

Helpers on the base: `World`, `Link`, `Clock`, `Localizer`, `Facts`, `Match`,
`Assignment`, `Commands`; `Emit`, `EmitPluginEvent`; `Lines(player)`, `Say`, `SayAll`,
`PrintCenter` (all localized per player); `PlayerState<T>(factory)`; `After`, `Every`.

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
the manifest names (decision 19): MatchZy's forwards translated by the core plugin for
`flow: matchzy`, the SDK's generic flow emitter for `flow: plugin | none` (PRD-02 T22), or
the mode itself when it knows better. Emitting a flow event through the runtime advances
the context: `going_live` sets `Live`, `map_end` bumps the map number and resets the
round, `side_swap` swaps the sides.

Every event a mode emits is stamped with the per-match `seq` hint (position ticks are
not: they are ephemeral) and the link gives it the per-server link `seq`.

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

## What the core plugin adds (PRD-02 T8)

The SDK has no CounterStrikeSharp code path yet. `EZPug.Core` — the plugin every server
runs — provides the `IGameWorld` and `IClock` over CounterStrikeSharp, reads the sidecar,
runs the `LinkClient`, owns the `GamemodeRuntime` and the gamemode loader (the runtime's
`Assigned`/`Released` events: `css_plugins load`, exec, cvars, the map), and exposes the
runtime to gamemode plugins through CounterStrikeSharp's shared plugin API so a hot-loaded
mode calls `Attach`. A mode attached after the assignment hears `OnAssigned` at once.
