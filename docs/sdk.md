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
| `IGameWorld` | players (SteamID64, slot, team, alive, position, scoreboard rating), say/print/center/HUD, the six verbs of a Panorama layout (below), one of the game's own sound events for one player, give/strip, respawn, health/armor/speed, the scoreboard's rating, exec cfg, cvars, changelevel and workshop maps, and every hook the engine raises (connect, spawn, death, round, freeze end, bomb, chat, map started, map ended on the win panel, tick) | the core plugin's CounterStrikeSharp adapter (PRD-02 T8) | `FakeGameWorld` |
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
| `OnPlayerJoined/Left(IGamePlayer)` | a connect / disconnect, bots included | the vocabulary event is emitted for humans and puppets by the runtime, never for a plain bot |
| `OnPlayerSpawned(IGamePlayer)` | a spawn | `life` charges refill here |
| `OnPlayerDied(PlayerDeath)` | a death | `player_death` is emitted by the runtime |
| `OnRoundStart(long)` / `OnRoundEnd(RoundEnd)` | the engine's round events | the round number is 1-based and in `Match.RoundNumber`; `round` charges refill on start |
| `OnChat(ChatLine)` | a line that was not a declared verb | `chat_message` / `chat_command` are emitted by the runtime when the manifest's `chat` capability is on |
| `OnPlayerCommand(player, command, args)` | a declared verb, after the SDK's checks; from the phone, or from chat — where the words after `!verb` become the args schema's first declared property (`ArgsValidator.FromChat`), so both doors hand the mode the same object | return `Ok` to spend the charge and start the cooldown; `Refused(message)` or `NotAlive` cost nothing |
| `OnProfile(RosterEntry)` | a profile pushed (open join, a refreshed rating) | already in `Assignment.Profiles` |
| `OnCommand(LinkCommand)` | a Match API command the runtime does not answer itself | `announce`, `moment`, `kick`, `rcon`, `profile` are the runtime's; `pause`, `unpause`, `restart_round`, `force_end`, `restore`, `reroll` are the mode's or the host's (`CommandHook`). Return `CommandAnswer.Deferred` and call `Link.AnswerCommand` later for work that waits on the engine; the orchestrator's deadline is fifteen seconds |
| `OnTick()` | every engine frame while assigned | |
| `OnDrain()` | finish what you have, take nothing new | |
| `OnEnd(reason)` | `release` | after it returns, the mode's timers are cancelled and its `PlayerState`s cleared |

Helpers on the base: `World`, `Link`, `Clock`, `Localizer`, `Facts`, `Match`,
`Assignment`, `Commands`; `Emit`, `EmitPluginEvent`, `PushWidget`; `Lines(player)`, `Say`,
`SayAll`, `PrintCenter`, `Toast`, `ToastAll` (all localized per player; the last two are
"A mode's own words on the HUD", below); `PlayerState<T>(factory)`; `After`, `Every`.

### Timers: a period is held, a stall is skipped

`After` and `Every` are the world's clock — on a server, `GameThreadClock`, fired from the
engine's frame, so a callback always runs on the game thread. What a mode may rely on
(PRD-04 T5):

- **A beat is up to one frame late, never earlier.** A timer fires on the first frame at or
  after its due time: at 64 tick, up to 15.6 ms; at `host_timescale 2`, 7.8 ms.
- **The lateness never adds up.** `Every(n)` re-arms from the beat's *due time*, not from
  the frame that fired it, so its `k`th beat is due at `armed + n·k` however long the frames
  are. `Every(100)` is ten beats a second, measured over any stretch, and the position
  stream is ten ticks a second rather than a frame slower per tick.
- **A stalled frame skips, never bursts.** A frame that arrives a whole period or more past
  a beat (a map change, a hitch) fires the timer once and re-arms it at the next beat still
  ahead; the beats in between are dropped, not owed. The price is that the beat after a late
  one can come less than a period after it — the grid is kept, not the gap.
- **The clock is a stopwatch**, not the engine's time: `host_timescale` does not speed a
  timer up (a match's `length` is divided by `simulation.timeScale` for that reason).

`FakeClock` visits every due instant as the test advances it, so a stall does not exist on
the harness: `Advance(1000)` over an `Every(100)` fires ten times, as ten beats of a second
would. `GameThreadClockTests` pins the server's rule on frames it lays down itself.

### Branding: the hostname, the voice, the card

A mode writes nothing for this either. The runtime's `Branding` (`Runtime.Brand`) turns
the request's `branding` block and the manifest into the four places a player sees the
match (decision 22; in-world banners need a Workshop addon and are a later round):

| Where | What |
| ----- | ---- |
| the server browser | `branding.hostname` when the request named one, else `EZPug · <event> · <mode> · <Map>` — the event only where `branding.eventName` was given. Clamped to 63 characters. The loader sets it on `assign` and writes the same string into `matchzy_hostname_format`, in the match file and on the console just before `matchzy_loadmatch`, because MatchZy rewrites `hostname` from that cvar on the load and every round |
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
and the platform brands them itself. The assignment's **warmup lines** are the third, for
the same reason.

### The HUD: layouts on a player's screen

Decision 34, `docs/hud.md` for the client half. CS2 lets a server show a Panorama layout
(`custom_hud_layout`): the layout's file is on the player's machine, in the Workshop addon
this repo builds, and the server sets only a class on a panel and a string a label binds.
`IGameWorld` has six verbs for that and **none that takes the mouse**:

| Verb | What it does |
| ---- | ------------ |
| `CreateHudLayout(layout, observable)` | one entity for a layout, named by its **source** path with the extension (`panorama/layout/custom_game/ezpug_welcome.xml`). `observable` is the entity's own key: somebody spectating a player is shown that player's version of the layout |
| `RemoveHudLayouts()` | every layout of ours in the world, found by the entity's name, so the ones a previous load of the plugin left behind go too |
| `SetHudClass(layout, panel, class, has)` and `SetHudClass(player, …)` | a class on a panel, for everybody or over that for one player |
| `SetHudVariable(layout, panel, variable, value)` and `SetHudVariable(player, …)` | the string behind `{s:variable}`, the same two ways |

Nothing calls those but the runtime's `Hud` (`Runtime.Hud`), which is the thing to talk
to: `Register(layout)` once, then `SetClass` and `SetVariable` with the same arguments.
`Register(layout, observable: true)` is for a layout about what happens to a player (the
moment's): whoever watches them sees it as they do. A layout that speaks to one person
(the welcome's "you play for…") stays theirs.
It keeps what should be on whose screen and owns the rules a layout breaks silently
without:

- **Off is untouched.** The HUD is on for a match when the server booted with the addon's
  id (`HudAddon`: `EZPUG_HUD_ADDON` or `hudAddon` in `ezpug.json`, plus
  MultiAddonManager's loader file) and the assignment says `hud`. Otherwise every call
  returns before it reaches the world. On, `mm_add_client_addon <id>` goes out at the
  assignment and `mm_remove_client_addon <id>` at the release.
- **No entity before a round has started on the map.** CounterStrikeSharp caches a failed
  look at the entity list for the life of the process. The layouts are made at the first
  `round_start` of each map, after anything of ours still in the world has been removed,
  and whatever was set before that is applied then. The world announces a map a second
  after the engine starts it, and a round can start inside that second: when the
  announcement shows that the layouts in the world were made on the map *before*, they
  are made again then (the dev node did exactly this on every MatchZy match, whose level
  change follows a round on the lobby map).
- **A slot is told everything again** when a person takes it, at every spawn, and two
  seconds after each (`Hud.ResendDelayMs`). The engine keeps a player's state by slot and
  slots are reused, and a client that is still loading drops what it is told.
- **Nothing is remembered as already set.** Every call goes out.
- **A bot and a puppet have no screen** and are skipped. So is a call that names
  somebody who has left: their slot belongs to whoever took it since.
- **Everything goes** at release and when the plugin unloads.

A class or a string is either everybody's or one player's. A slot's own value wins over
everybody's and cannot be taken back, so a name that was ever set for one player stays
per player (the service warns when the two are mixed).

`Hud.Quiet` answers **is anybody playing, and for how long not**: `null` while a round is
being played, and otherwise a reason (`NoRound`, `Warmup`, `FreezeTime`, `RoundOver`,
`Paused`, `Halftime`, `MatchOver`) with the milliseconds left where the engine's clock
bounds it. The freeze time is `mp_freezetime` less what has passed since `round_start`,
and a decided round is the rest of `mp_round_restart_delay` plus the freeze that follows.
`Quiet?.Fits(ms)` is the question a card asks before it shows. `IGameWorld.FreezeEnded`
is the instant a freeze ends, which is when a card is put away. A mode with no freeze
time and endless respawns is being played from its first round start to the end of its
map.

The runtime draws one layout of its own, **the welcome** (`Runtime.Welcome`,
`docs/hud.md`, "The welcome"): the connect card as a HUD card, for somebody who arrives
while nobody is playing. `Branding` asks `Welcome.Show(player)` at the moment it would
print the centre card and prints that card only when the answer is no, so a player never
gets both and a match with the HUD off gets the centre card it always did. The welcome's
words are the SDK's (`hud.welcome.*` beside `branding.card.*` in `Lines.*.resx`), and a
mode adds nothing to it.

The second layout is **the moment's** (`Runtime.Moments`, `docs/hud.md`, "The moment"):
what the Match API's `moment` command becomes. Its line goes out in chat behind the
match's prefix whatever the server can draw. With the HUD on, everybody also gets a toast
and the person a card, and the card is shown only in a stretch `Hud.Quiet` says is long
enough for it. A mode has nothing to do for any of it, and its own toasts share the
moment's rows (below). The sound at the card's turn is
`IGameWorld.PlaySound(player, soundEvent, volume)`: one of the game's own sound events
(a name from its `soundevents/*.vsndevts`), to one player; `World.Sounds` on the harness
is what was played to whom.

On the harness, `new GamemodeTestHost(hudAddon: "…")` is a server that can draw and
`AssignmentFor(…, hud: true)` a match that asks. `World.HudLayouts` holds each layout as
the engine would, per slot and surviving a disconnect, `layout.Has(slot, panel, class)`
and `layout.Variable(slot, panel, variable)` read a screen, `World.HudActions` is every
HUD verb in order, `World.OrphanHudLayout` plants a leftover and `World.EndFreeze()` ends
a freeze.

#### A mode's own words on the HUD: `Toast` and `ToastAll`

What a mode draws is a **toast**: its own line as a slim strip at the right edge of the
screen, under the kill feed, for six seconds.

```csharp
Toast(player, "powerup.landed", Lines(player)["powerup.kind.speed"]);  // one person
ToastAll("powerup.bye");                                               // everybody, each in their language
```

`Toast` is `Say` and `ToastAll` is `SayAll`, with the same key and the same arguments,
and each **says the chat line first**, behind the match's prefix, whatever the server can
draw. With the HUD on the line is also the strip. So a mode never asks whether the HUD is
on, and somebody without the addon misses nothing. The strip carries the line without the
prefix and without the chat's colours (`ChatColor` is control characters, which a label
would draw as boxes), cleaned the way every line on it is (`SaidLine.Sanitize`).

The strips are the moment's three rows (`Runtime.Moments` owns them), so a mode's toast
and a drop's wait for each other: three on screen, the next ones taking a row as it comes
free, at most six waiting, and one beyond that said in chat and not drawn. A mode's toast
is plain where a moment's is tinted. **A row is everybody's**: a toast for one person
holds its row for the six seconds on every screen, and is simply not shown on the others.

**The rules a mode must not break.** The first three are what decision 34 says the HUD
may never do; the rest are how a layout fails without telling anybody.

- **Decoration, never structure.** Nothing a mode does may wait for the HUD, depend on it
  or read anything back from it. There is no "was it shown": a client without the addon,
  one still loading and a bot all look the same from here. What a player has to know is
  said in chat, which `Toast` does for you; a line that exists only on the HUD is a line
  some players never get.
- **Nothing takes the mouse.** The seam has no verb for input capture and a test fails
  when the call appears anywhere in this repo. A mode that wants a menu has the phone
  (`PushWidget`, player commands) and chat.
- **Nothing covers a fight.** A toast is slim and at the edge, and that is all a mode
  puts on a screen while a round is being played. Anything larger is a card, a card may
  only show while nobody is playing (`Hud.Quiet`), and the cards are the runtime's.
- **Use the helpers, not the seam.** `World.CreateHudLayout`, `SetHudClass` and
  `SetHudVariable` are reachable from a mode and are not for it. A class set past
  `Runtime.Hud` is dropped by a client that is still loading and never told again, and it
  stays on the slot for whoever takes it after a disconnect; a layout made before a round
  has started on the map breaks the entity list for the life of the process. The toast's
  rows are not a mode's either: `moment_toast_<n>` set from a mode is a toast written
  over a drop's.
- **A mode ships no layout.** A layout is a compiled file in the Workshop addon, the
  same for every server, and a changed one needs the addon republished and every client
  restarted (`docs/hud.md`). A mode that needs a panel of its own is a change to the
  addon and a round of its own, not a file beside the manifest.
- **A toast is something worth a glance, a few times a round.** Every call goes out to
  the client (nothing is remembered as already set) and holds a row for six and a half
  seconds, on a strip the platform's drops use too. A line that changes every second is
  the centre panel's: `powerup-dm`'s peek countdown is `World.PrintHud` ten times in five
  seconds and stays there.
- **Words come from the resx pair**, per player, German by default, like everything a
  human reads. A name from outside goes in as an argument and through `ChatColor.Strip`
  first, as it does for chat.

On the harness a toast is read off the moment's layout, the way `ModeToastTests` does:

```csharp
var layout = host.World.HudLayout(Moments.Layout);
Assert.True(layout.Has(player.Slot, Moments.Toast(1), Moments.Shown));
Assert.Equal("Power-up aktiv: Tempo.", layout.Variable(player.Slot, Moments.ToastText(1), Moments.Text));
```

and the chat line in `World.Said` is the assertion that holds on every server. A puppet
has no screen, so a lane row proves the line and never the strip.

### Warmup lines: what the server says while it waits

A mode writes nothing for this either. The request's `warmupLines` arrive on the `assign`
frame as text — the platform rendered them, in the roster's majority locale
(`Assignment.MajorityLocale()`), because one line everybody reads at once cannot be four
languages — and the runtime's `WarmupChat` (`Runtime.Warmup`) prints them:

- one every `WarmupChat.IntervalMs` (eight seconds), in the order the client wrote them,
  **cycling**, so a player who connects two minutes late reads the whole set;
- only **in warmup**, which is the engine's word (`IGameWorld.Rules.Warmup`) where there
  are gamerules to read and "the match has not gone live yet" where there are none — a
  knife round and a live round are quiet, and the next map's warmup speaks again;
- starting when the map is up and configured (the `server_ready` beat), not at `assign`,
  and stopping at `release`.

Every line from outside — a warmup line, an `announce`, `ezpug_announce` — goes through
`SaidLine.Sanitize` first: control characters (the engine's colour palette lives in that
range), `;`, `"` and `\` become spaces, runs of whitespace collapse, and the line is
clamped to 127 code points, which is what one CS2 chat line shows. A line with nothing
left is dropped rather than printed blank: the command is refused
(`validation_failed`) and a warmup line is left out at assignment. It is the C# twin of
the simulator's `sanitizeChatLine`, and a simulated server prints the same warmup lines,
at the same pace, as a `chat_announced` `plugin_event` — so a client renders a rehearsal
and a match the same way.

A name that arrives from outside — an event, a team, a hostname — is passed through
`ChatColor.Strip` before it is pasted into one of ours, and the card's markup is escaped,
so nobody colours the rest of a chat line or breaks the panel by what they called their
team. `ChatColor` holds the engine's palette as code points; the card is HTML, because
that is what the centre panel reads.

### A length: what ends a mode with nothing to win

A round-based mode ends when the engine has counted its rounds and the generic flow emitter
reports the win panel. A free-for-all has no such thing, so the manifest declares a
`length` (`docs/gamemodes.md`, "Length") and the SDK enforces it — `MatchLength`, owned by
the runtime like the emitter, for every flow the emitter tells (`plugin`, `none`), never
for `matchzy`, and never over a mode whose class says `OwnsFlow`. A mode writes nothing:

```json
"length": { "durationSeconds": 600, "fragLimit": 30, "idleTimeoutSeconds": 300 }
```

- **The duration** starts when the emitter says `going_live`, which carries
  `length: { durationSeconds, fragLimit }` as *in force*: the SDK's timers are real
  milliseconds and a simulated match may run the engine faster, so the manifest's seconds
  are divided by `simulation.timeScale` — for the timer and for the fact alike.
- **The frag limit** counts kills per player while the map is live; a suicide and a death
  to the world are nobody's. The death is emitted before the end it causes.
- **The idle timeout** runs whenever nobody is on the server — from `server_ready`, and
  from the last person leaving — and a connect cancels it. A person is a human or a puppet
  (`IsBot && !IsPuppet` is furniture), or a room of request bots would bill for ever.

Whichever comes first calls `GenericFlow.End(reason)`: `map_end` if the map was live,
`series_end` always, both with `reason`, no winner for `slots.teams: 1`; the humans are told
in their own locale (`length.ended.*`), and the emitter then says nothing until the next
assignment, because the engine plays on for the second the release takes. On the harness
it is `host.World.Elapse(600_000)` and an assertion on `SeriesEndEvent.Reason`
(`MatchLengthTests`). A mode that declares a duration should set the engine's own clocks
out of its way (`mp_timelimit 0`): `mp_timelimit` counts from the map load, not from going
live, so two equal clocks mean the engine wins by the length of the warmup and the end
carries no reason.

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
  and reads its ranking back as `0` however often it is written — a puppet too, and not
  because a spawn clears it: PRD-04 T6 wrote it again mid-round, with no spawn near, and
  read `0` a second later (`docs/gamemodes.md`, `scoreboardRating`). So a bots run proves the
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

**Each tick carries the utility layer too** (PRD-05 T2c, ezpug/ezpug-iron#5): the world's
`SampleGrenades()` and `Bomb` go out beside the positions as `grenades` and `bomb`.
`grenades` is always there, empty when nothing is in the air, because a missing list tells
the client nothing was sampled. A tick goes out when anybody is alive **or** any grenade is,
so a smoke still standing over a round everybody died in is still drawn. The core plugin
keeps the layer in `UtilityBook`, which the game's **events** feed through `UtilityTracker`.
It started out following entities from `OnEntitySpawned` to `OnEntityDeleted`, and on the dev
node (CounterStrikeSharp 1.0.373) that listener never fired for the plugin at all, through two
puppeted matches, while every game event registered beside it arrived. Every change of state
has an event with a position, so that is what it keys on:

- a **throw** (`grenade_thrown`) makes the next sample look for new projectiles once. Each
  one it finds is read by index while it flies, and a handle that no longer answers is gone;
- a **smoke** stands from `smokegrenade_detonate`, at the position the event carries, with a
  144-unit radius, until `smokegrenade_expired`;
- a **molotov** or **incendiary** fire starts on `inferno_startburn` under the id of the
  projectile that landed nearest it (else the oldest fire throw still waiting names its kind
  and thrower). While it burns, the inferno is read for the centre of its burning flames and
  the furthest one plus 30 units, until `inferno_expire`;
- a **flash** or an **HE** pops once on its detonate, a **decoy** on `decoy_started`, where it
  lands and starts firing. `SampleGrenades()` consumes the pops, which is why the ticker is
  its one caller;
- the **bomb** follows `bomb_pickup`, `bomb_dropped` (then its entity, while it falls),
  `bomb_planted` (the `planted_c4`'s origin and the event's site), `bomb_exploded` and
  `bomb_defused`. The engine hands it out at spawn without an event, so it is looked for once
  at a round's start and again when freeze time ends;
- `round_prestart` and a map start forget everything, because the engine removes grenades
  then without saying so.

A read the engine refuses is left off the tick and said once in the plugin's log
(`utility: reading … failed`), so an empty layer is never silent.

A grenade's id is its entity handle (index and serial number), so an index the engine reuses
is still a new grenade. A thrower resolves through the pawn's controller to the world's player,
so a puppet's smoke is the rostered player's. On the harness, `FakeGameWorld.Grenades`,
`Pop(...)` and `Bomb` put utility on the map.

**Bots** have no SteamID64, and the vocabulary insists on one: `BotIdentity.SteamId64Of(slot)`
names a bot `90000000000000000 + slot`, stable for its connection and outside anything Steam
issues; `BotIdentity.IsBot(id)` reads it back. The core plugin applies it, the harness may
(`World.Connect(BotIdentity.SteamId64Of(1), "Bot Cliff", bot: true)`), and a bot's death is a
real `player_death`.

## Puppets

A **puppet** is a bot that plays a rostered player's seat, so a real server can play a whole
match with nobody on it and reach it through the doors a human uses: connect, ready up, play,
leave (PRD-03). The request asks with `simulation` and a key holding the `simulation` scope,
and the mode claims `capabilities.simulation` (`docs/match-api.md`, `MatchRequest`; decision
25). Every fact of the match carries `source.simulated: true`, stamped by the orchestrator.
Under every flow except `matchzy`, the SDK seats the puppets. Under `matchzy`, MatchZy-Enhanced's
simulation mode seats them and the SDK only learns who is who. Either way a puppet is the
roster entry on the wire. How to run one is in `docs/operations.md`: "Puppets, and the escape
hatch" for the lane, and "A puppet match" for `ezpug-iron matches create --simulate`.

**A mixed roster** (PRD-04 T2): `simulation.puppets` may name a subset of the roster, and
`Assignment.IsPuppet(steamId64)` is the one reading of it — the match is simulated, the
player is rostered, and the list names them or names nobody in particular. The puppeteer
seats exactly those; a roster entry the list leaves out is a person, whose chair stays empty
(`Assignment.HumansAmongPuppets` counts them) until they connect through the mode's ordinary
door, at which point they are the rostered player they always were. A bot that arrives while
such a chair is empty is a plain bot: `Casting` only ever fills a puppet's seat, so the
person's SteamID is never spoken for. The flows the SDK tells the story of have no ready gate
— `GenericFlow` goes live on its own clock — so a person joins such a match *live*, as on any
drop-in server. Under `matchzy` the SDK seats nobody: our fork of MatchZy-Enhanced spawns a
bot for each seat the list names, and a person's seat is written into its match file as
`{ "name", "simulated": false }` (PRD-04 T2b). The fork holds the warmup until the person is
there and ready, so under `pug` a person joins *before* the match goes live.

### Seating a puppet

**Puppets** are the other kind of body the engine plays (PRD-03 T7), and the two are never
mixed up: a plain bot is never rostered and never announced, a puppet is a roster entry made
flesh. When the assignment carries `simulation` and the flow is not `matchzy` (MatchZy seats
its own), the runtime's `Puppeteer` sends home whatever bots the mode's cfg brought, then
asks the engine for one bot per roster entry that is a puppet — one at a time, team A and
team B by turns, asked again after five seconds if it never arrives — and casts each as it
arrives.

- **Identity is decided before the first hook.** `IGameWorld.Casting` is asked about every
  bot the engine adds; one that comes back with a `PuppetRole` is `IsBot` *and* `IsPuppet`,
  and its `SteamId64` and `Name` are the roster's from then on. Everything that speaks about
  a player needs no special case: the death, the position, `World.Find` for a `kick` or a
  widget tap addressed to the rostered id, `Assignment.ProfileOf`, the player's team.
- **Announced like a person.** `player_connected` and `player_disconnected` are emitted for
  a puppet; a seat that empties (a kick, a map change) is filled again and announced again.
  What stays a bot's is what only a client could read: the connect card, the rating greeting,
  `SayAll`.
- **Sides.** A two-team mode gets each puppet on its team's side (`bot_add_ct` / `bot_add_t`
  by the sides in effect); a one-team mode leaves it to the engine or the mode's own balancer.
- **The clock.** `simulation.timeScale` is applied as `host_timescale` under `sv_cheats 1`
  when the map is ready and put back at release.
- **On the harness**, `World.AddBot` only records the asking; `World.ArriveAskedBots()` is
  the engine getting round to it, and `World.ArriveBot("BOT Cliff")` is a bot nobody asked
  for. `PuppetTests.cs` is the worked example.

### Scenarios: one language, and no knob that quietly does nothing

A puppets request may name a **scenario** (`simulation.scenario`) from the catalog
`GET /v1/sim/scenarios` lists — the same table the simulator plays, so a story a loop
watched on the `sim` provider is a story a real server is asked for by the same name
(PRD-03 T11). The orchestrator resolves the name into knobs and the assignment carries
those (`assign.puppets`); no plugin holds a second copy of the table, and the puppeteer
reads a seating plan rather than a word it has to interpret.

A knob nobody on hardware can execute is **refused at the door**, `validation_failed` on
`simulation.scenario`, rather than silently doing nothing on a match somebody ran. Which
is which lives in one place, `packages/sim/src/scenario.ts`, and this table is that table:

| Knob | On a real server | |
| --- | --- | --- |
| `absentPlayers` | **the puppets** | a roster entry with no puppet: the puppeteer seats every entry but the last few, and the orchestrator’s join deadline is what gives up on them |
| `idle` | **the puppets** | nobody is seated at all, on a server that is otherwise a normal one: the mode’s `length.idleTimeoutSeconds` ends the match, or the join deadline does |
| `neverReady` | refused | it is the *server* that never boots, not a player who never readies — a provider failure, armed on the provider by the fault-injection suite rather than asked for by a match |
| `crashAfterRound` | refused | a request cannot ask a box to die: the recovery window it opens is driven from outside the match, by the fault suite on the simulator or by a hand on the container |
| `pauses` | refused | nothing pauses a stock server but an admin, and that admin is the Match API’s own `pause` command — the lane pauses a live match through the front door instead (PRD-03 T6) |
| `overtimes` | refused | two even sides of bots cannot be made to draw on demand — PRD-03 T6 counted an overtime in five of the matrix’s ten maps and could force none of them |
| `comeback` | refused | nothing scripts a bot’s aim, so no real server can be told who trails at the half |
| `towerEnding` | refused | the map’s own script decides every tower round, and nothing walks six bots into a castle or holds them at 7–7 on cue |

Two more things follow from who holds the bodies. **Under a `matchzy` flow even the two
knobs a puppet can do are refused**: MatchZy-Enhanced's simulation mode seats one bot per
*configured* player, re-readies whatever its reconcile pass finds and force-readies both
teams from its warmup watchdog, so neither an absent puppet nor a silent one can be
expressed without patching the fork. And a scenario's `winner` never travels at all — no
named scenario sets it, and nothing on a server could honour it.

### Under `matchzy`: the fork seats them

**Under `matchzy` the fork seats them and the cast arrives late** (PRD-03 T7a). MatchZy-Enhanced's
simulation mode spawns one bot per roster entry itself and decides which is which seconds
afterwards, so there is nothing to answer at the door: the body is already a plain bot by
the time anybody knows who it plays. `IGameWorld.Recast(slot, role)` is the seam for that —
it rebuilds the player over the same controller and raises `PlayerConnected`, which is the
first word anything said about that body, since a plain bot is never announced. A body
handed a *different* roster entry sees the person it was out first; a slot already cast as
the same person is left alone. The core plugin's `MatchZyPuppets` is the one caller, and
what it reads is the fork's own console lines rather than a guess of its own — see
`docs/operations.md`, "Puppets". A mode never calls either seam; `FakeGameWorld.Recast` is
how a test drives it.

**A player's team is the roster's word** (`Facts.SlotOf`): `team_a`/`team_b` for a rostered
player wherever they stand, `unrostered` for a body the request never named while it plays
on a side, `spec` while it is on none.

### Movement: puppets keep the engine's own, and why (PRD-03 T12)

A puppet moves itself. The SDK never drives a body along a path in a match anybody
watches, and this is the measurement that decided it rather than a preference.

**The question** was whether a round of movement parsed out of a real demo could be
replayed by puppets — positions per player per tick — so that a radar, a minimap and
everything else that draws a match could be developed against a server with nobody on it.
Two things had to hold: a body had to *move* smoothly enough under `Teleport`, and a death
at the demo's tick had to be creditable to the right attacker. The first holds. The second
does not, and it takes the first down with it.

**What the movement measures at.** `PuppetWalk` (behind the server console's `ezpug_walk`,
refused unless the match asked for simulation) walks every puppet around a circle of a
known radius at a known speed, teleporting once per engine frame; the lane's `radar` row
plays a `powerup-dm` of four puppets and reads the `position_tick`s back off the Match
API's stream — the same door a platform's radar has. Two windows in one match, ten seconds
of the engine's own bot AI and twenty seconds of the walk, as the step between one tick and
the next:

| | median | p95 | max | standing still | p95/median |
| --- | --- | --- | --- | --- | --- |
| the engine's bots | 28.1 | 49.9 | 61.6 | 25 % | 1.77 |
| teleported | 54.1 | 55.6 | 56.6 | 2 % | 1.03 |

The commanded step was 50 units, every body was in every tick, and the two runs agree to
the decimal. **Teleport per frame is smoother than a bot is**, and a radar drawing it would
draw a player running.

Two things fell out of that table. The 54.1 where 50 was asked for was the **position
ticker's real period**: `GameThreadClock.Every` re-armed at `now + interval` on the frame it
fired, so the stream's "every 100 ms" was 100 ms plus a frame — 108 ms, measured twice. It
now re-arms from the due time ("Timers", above; PRD-04 T5), and the same row on
2026-09-22 measured a median step of 48.6 — **97.2 ms, inside the 7.8 ms frame** the row
now asserts — and 200 ticks in the 20-second window, ten a second exactly. A
`position_tick` still carries no timestamp, by design, so ten a second is the rate a radar
may interpolate on. And the engine's own bots are the row above:
they stand still a quarter of the time and their step varies by three quarters of its
median, which is what real movement looks like from this door.

**The death is what cannot be done.** CounterStrikeSharp offers no supported way to credit
a death to a chosen attacker at a chosen instant: `CommitSuicide` credits nobody, there is
no usercmd hook so a bot cannot be made to fire, and the one entry point that takes an
attacker — `VirtualFunctions.CBaseEntity_TakeDamageOld` with a hand-built
`CTakeDamageInfo`, whose only constructor takes a raw pointer — is bound to a **byte
signature** in `server.so` (`CBaseEntity_Teleport`, by contrast, is a vtable offset). That
is the class of thing that broke the input-injection route on 2026-08-04 and the reason
this round rules it out.

**And the engine stops telling its own story under a teleport**, which closes the fallback
of letting the bots do the killing while their feet follow a demo. The second run wrote its
windows down and counted the durable log inside them: **zero** deaths in the twenty seconds
the four puppets were walked, against **four** in the ten seconds before, in a deathmatch
that went back to two or three every ten seconds once the walk was over. The first run,
whose windows were not yet recorded, has no death at all in the two ten-second buckets the
walk falls in and ten in the thirty seconds before it. A replayed round would be a round in
which nobody ever dies.

So a `radar` scenario and a tracks fixture are not this round's, the demo remains the
authoritative movement record, and puppets keep the engine's own movement. The instrument
stays: `EZPUG_CS2_CASES=radar` repeats the measurement, and anything that would change the
answer — a CounterStrikeSharp release with a supported damage verb, a native input path —
has a number to beat.

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

**Every step of that is now proved on a real server by a puppet** (PRD-03 T8), and the
hardware reads the whole order back in one run: the CS2 lane's `widget` row mints a player
token for a rostered puppet in a `powerup-dm`, taps `powerup` over the widget socket
(applied, `chargesLeft: 0`, the mode's `powerup_claimed` in the durable log and the peek's
pushes on that one phone), taps again inside the fifteen milliseconds between the puppet's
death and its respawn (`not_alive`, "Nur lebend möglich."), and taps once as a SteamID the
request never rostered (`not_in_match`). `no_charges` shows up on the way past, because the
grant spent that life's charge — the refill on spawn, measured rather than asserted.

## The link

`LinkClient` is decision 5 in one class: one `ClientWebSocket` to the orchestrator's
`/link`, and the behaviour the TypeScript fake server pins in
`packages/protocol/fixtures/link/*.json` — `EZPug.Sdk.Tests` replays every one of those
files against it, frame for frame, byte for byte.

- **Hello first.** The token from the sidecar, the versions, the capabilities (and `hud`
  on a server that booted with the HUD's addon, decision 34), the plugin
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
