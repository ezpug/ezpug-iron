using System.Text;
using EZPug.Sdk.Protocol;

namespace EZPug.Sdk;

/// <summary>How the reel moves: the server's steps, or the old slide kept for a look.</summary>
public enum ReelMode
{
    /// <summary>The server steps the strip one slot at a time on its own schedule (decision 36). What a match plays.</summary>
    Steps,
    /// <summary>One 6 s transition over the whole way, declared in the class that starts it: what the playtests of 2026-10-04 and 2026-10-05 saw jump and stick. Only <c>ezpug_unbox_test slide</c> plays it, so a client can show the two side by side.</summary>
    Slide,
}

/// <summary>
/// <b>The unboxing</b> (PRD-08 T4, the reel redrawn in PRD-09 T8): a drop about somebody
/// that carries a reel is the one moment the whole server watches. The call ("Ada hat
/// einen Drop! Mal sehen…"), a reel of the decoys that the server steps past the marker,
/// fast and then slower, to a stop on the prize, then the reveal, on the last panel of
/// the moment's layout (<c>#unbox</c>, <c>hud/styles/ezpug_unbox.css</c>). The command
/// says who won what and what else the draw could have given; the slots, the stopping
/// place and every instant are chosen here.
///
/// <para>The rules, each a test on the fake clock in <c>UnboxingTests</c>:</para>
/// <list type="bullet">
/// <item><b>It plays only where all of it fits.</b> The layouts are in the world and
/// nobody plays for <see cref="UnboxMs"/> and <see cref="UnboxSpareMs"/> more: a freeze
/// with that much left, a warmup, a pause standing in a freeze, halftime, the map's end.
/// Anywhere else the moment is what it was before reels existed, at once: the line, the
/// toast, the card. A decided round is the exception: the win panel is up and a freeze is
/// seconds away, so the unboxing waits for that round start, which plays it or, in a mode
/// whose freeze is too short, shows it the old way.</item>
/// <item><b>The beats.</b> The call at once, in chat too; the reel
/// <see cref="CallMs"/> later; the reveal <see cref="ReelMs"/> after that, which is the
/// contract's <c>MOMENT_UNBOXING_REVEAL_MS</c> after the moment was due; everything gone
/// <see cref="PrizeMs"/> later. The reveal sounds by tier (<see cref="RevealSoundOf"/>),
/// the game's own case opening, for everybody watching. <b>The line is said at the
/// reveal</b>, not before: chat is on every screen, and a line that names the prize would
/// open the box before the reel stopped.</item>
/// <item><b>The reel is the server's motion</b> (decision 36). The strip stands with
/// slot <see cref="ReelRestSlot"/> under the marker and the server moves it one slot a
/// step, <see cref="ReelSteps"/> steps on <see cref="Steps"/>, a class for everybody
/// (<see cref="StepClass"/>) that the strip's own short transition animates, and the
/// tick (<see cref="TickSound"/>) in the same frame: sight and sound are one clock, and a
/// client that animates nothing still sees the decoys change in step with the ticks. The
/// last step is the prize's slot, with most of a second to stand before the reveal.
/// Nothing else is written to any layout while it runs.</item>
/// <item><b>The same moment, the same reel.</b> The slots and the landing come from a
/// seed over what the moment says (never its correlation id), so a redelivered command
/// shows what the first one did. The prize is in <see cref="ReelStopSlot"/>.</item>
/// <item><b>Put away at once.</b> The instant somebody is playing every class comes off.
/// If the prize had not shown yet, nobody knows what was won: the line, the toast and the
/// card follow in that instant, as for a moment that never had a reel. The step class
/// comes off <see cref="StripBackMs"/> later, once the panel has faded, so the strip
/// slides back to its start unseen.</item>
/// <item><b>One at a time.</b> A second unboxing waits for the next stretch that fits,
/// at most <see cref="UnboxingsWaitingMax"/> of them and each no longer than
/// <see cref="CardWaitMs"/>; one that waited too long is shown the old way.</item>
/// <item><b>Whoever was there when it began.</b> The beats are each person's own classes,
/// so somebody who connects in the middle sees nothing of it (and reads the line), and a
/// spectator sees what the player they watch sees. The reel's pictures, the steps and
/// the name are everybody's, and invisible to whoever is not shown the panel.</item>
/// <item><b>The winner need not be here.</b> The name is the player's on the server, or
/// the roster's; a puppet's seat counts. A drop about somebody this server has no name
/// for is a moment without a reel.</item>
/// <item><b>A map change</b> takes the one on screen and the ones waiting; a line that
/// was never said is said. <b>A release</b> takes everything, silently.</item>
/// <item><b>The switch</b> (<c>ezpug_unbox_reel 0</c>, <see cref="ReelOn"/>): off, a drop
/// with a reel is PRD-07's moment, the line, the toast and the card, and nothing is
/// written to the reel. An admin flips it without a deploy; <c>ezpug_status</c> says.</item>
/// <item><b>The diagnostic</b> (<c>ezpug_unbox_test</c>, <see cref="PlayTest"/>): plays a
/// reel now for whoever is on the server, in any stretch or none, about the first person
/// here, with a choice of the steps or the old slide, so a look at a client answers in one
/// join. It needs the layouts in the world and nothing else.</item>
/// </list>
/// </summary>
public sealed partial class Moments
{
    /// <summary>How many slots the reel has (<c>unbox_slot_1</c> onwards).</summary>
    public const int ReelSlots = 36;

    /// <summary>The slot under the marker while the reel stands: the stylesheet's resting position.</summary>
    public const int ReelRestSlot = 4;

    /// <summary>The slot the reel stops on, and so the prize's: the stylesheet's last step puts it under the marker.</summary>
    public const int ReelStopSlot = 33;

    /// <summary>How many steps the reel takes: one a slot, from the resting slot to the prize's.</summary>
    public const int ReelSteps = ReelStopSlot - ReelRestSlot;

    /// <summary>How many places within its slot the reel may stop at (<c>land-1</c> onwards).</summary>
    public const int ReelLandings = 4;

    /// <summary>How long the call stands before the reel moves: long enough to read a name and six words.</summary>
    public const long CallMs = 2_000;

    /// <summary>How long the reel has, from its first step to the reveal: the game's own reel is 6 s, and the reveal's instant is the contract's.</summary>
    public const long ReelMs = 6_000;

    /// <summary>When the prize shows, after the moment was due: the one instant the contract shares with a client.</summary>
    public const long RevealMs = CallMs + ReelMs;

    /// <summary>How long the prize is held before everything goes.</summary>
    public const long PrizeMs = 4_000;

    /// <summary>The whole sequence.</summary>
    public const long UnboxMs = RevealMs + PrizeMs;

    /// <summary>What must be left of the stretch after the sequence: it ends with time to spare, and Rush's thirteen seconds never fit.</summary>
    public const long UnboxSpareMs = 1_500;

    /// <summary>The gap between two unboxings, so the second starts from a panel that has faded and a strip that is back at its start.</summary>
    public const long UnboxRestMs = 500;

    /// <summary>How many unboxings wait for a stretch before the next one is shown as a moment without a reel.</summary>
    public const int UnboxingsWaitingMax = 4;

    /// <summary>How long one step slides on the client: the strip's own transition in <c>ezpug_unbox.css</c>, which a test reads back. Shorter than the slowest gap between two steps, so the strip never lags behind the ticks.</summary>
    public const long StepMs = 150;

    /// <summary>How long after the panel is put away the step class comes off: past the panel's 0.12 s fade, so the strip slides back to its start unseen, and inside <see cref="UnboxRestMs"/>.</summary>
    public const long StripBackMs = 200;

    /// <summary>The unboxing's panel: the beats, per person; the prize's tier, picture and the winner's side, and the reel's step, for everybody.</summary>
    public const string Unbox = "unbox";

    /// <summary>The winner's name.</summary>
    public const string UnboxName = "unbox_name";

    /// <summary>The call under the name, in the reader's language.</summary>
    public const string UnboxCall = "unbox_call";

    /// <summary>The line under the prize: the item's, and the winner's own for the winner.</summary>
    public const string UnboxLine = "unbox_line";

    /// <summary>On the panel: the prize is out.</summary>
    public const string Revealed = "revealed";

    /// <summary>On the panel, per person, only for <see cref="ReelMode.Slide"/>: the old one-transition slide.</summary>
    public const string Slide = "slide";

    /// <summary>On the panel: the winner plays CT, or T. Neither is nobody's side.</summary>
    public const string SideCt = "side-ct";

    /// <inheritdoc cref="SideCt"/>
    public const string SideT = "side-t";

    /// <summary>The key of the call in the SDK's catalog.</summary>
    public const string CallKey = "hud.unbox.call";

    /// <summary>
    /// The tick as a slot comes under the marker: the game's own, what its case opening plays
    /// for every item the reel passes (<c>sounds/ui/csgo_ui_crate_item_scroll.vsnd</c>, in
    /// <c>soundevents/game_sounds_ui.vsndevts</c>). Nothing ships in the addon.
    /// </summary>
    public const string TickSound = "UIPanorama.container_weapon_ticker";

    /// <summary>How loud a tick plays: under the freeze's own sounds, the buying and the footsteps.</summary>
    public const float TickVolume = 0.5f;

    /// <summary>The least gap between two steps: the server schedules on its 64 Hz frames and the event plays one instance at a time. A test holds the schedule above it; nothing is skipped at runtime, because a skipped step would leave the strip a slot behind.</summary>
    public const long TickGapMinMs = 60;

    /// <summary>How loud the reveal plays for everybody but the winner, who hears it at the event's own volume.</summary>
    public const float RevealVolume = 0.7f;

    /// <summary>How far apart two slots' centres are, in the layout's pixels.</summary>
    public const int ReelPitchPx = 140;

    /// <summary>
    /// The reel's pace, as a bezier over its time (x) and its way (y), the plugin's own
    /// since the steps replaced the slide: a slot every 67 ms at the start, the game's own
    /// fastest tick, slowing all the way, the last step with a second to stand before the
    /// reveal. <c>cubic-bezier( 0.2, 0.65, 0.4, 1 )</c> before it (PRD-09 T1) put the last
    /// step at 4.4 s and left the prize standing for 1.6 s, too long for a stop that no
    /// longer creeps.
    /// </summary>
    public static readonly IReadOnlyList<double> ReelCurve = [0.2, 0.65, 0.55, 1];

    /// <summary>Where in its slot the reel stops for each landing, from <c>land-1</c>: the stylesheet's second slide, in pixels.</summary>
    public static readonly IReadOnlyList<int> LandingPx = [-46, -20, 18, 44];

    /// <summary>
    /// The reveal by tier: the game's own sound for an item awarded out of a case, a
    /// different one for each rarity (<c>sounds/ui/panorama/case_awarded_*.vsnd</c>). Our
    /// four tiers are Valve's rarities of the same names and colours; theirs above
    /// legendary (ancient) are not ours. A different sound per tier, because nobody knows
    /// yet whether a CS2 client lets the volume we send scale an event.
    /// </summary>
    public static string RevealSoundOf(MomentTier tier) =>
        tier switch
        {
            MomentTier.Uncommon => "UIPanorama.ItemDropUncommon",
            MomentTier.Rare => "UIPanorama.ItemDropRare",
            MomentTier.Legendary => "UIPanorama.ItemDropLegendary",
            _ => "UIPanorama.ItemDropCommon",
        };

    /// <summary>
    /// When, after the reel starts, each step is taken and its tick played: the instant
    /// the marker would cross into slot <see cref="ReelRestSlot"/> + k on the curve, k
    /// from 1 to <see cref="ReelSteps"/>. Every reel takes the same steps whatever its
    /// landing (the landing is a few pixels on a second panel). A test pins the schedule.
    /// </summary>
    public static IReadOnlyList<long> Steps { get; } = [.. Enumerable.Range(1, ReelSteps).Select(k => (long)Math.Round(TimeAt((k - 0.5) / ReelSteps) * ReelMs))];

    /// <summary>The share of the reel's time at which the curve has covered <paramref name="progress"/> of its way: the curve's parameter by bisection, then its time.</summary>
    private static double TimeAt(double progress)
    {
        static double Bezier(double s, double a, double b) => 3 * (1 - s) * (1 - s) * s * a + 3 * (1 - s) * s * s * b + s * s * s;

        double low = 0, high = 1;
        for (var step = 0; step < 50; step++)
        {
            var middle = (low + high) / 2;
            if (Bezier(middle, ReelCurve[1], ReelCurve[3]) < progress)
            {
                low = middle;
            }
            else
            {
                high = middle;
            }
        }

        return Bezier((low + high) / 2, ReelCurve[0], ReelCurve[2]);
    }

    /// <summary>A slot of the reel, 1 to <see cref="ReelSlots"/> from the left: a picture and a tier, for everybody.</summary>
    public static string ReelSlot(int slot) => $"unbox_slot_{slot}";

    /// <summary>The reel's step, 1 to <see cref="ReelSteps"/>: on the panel, for everybody; slot <see cref="ReelRestSlot"/> + k is under the marker.</summary>
    public static string StepClass(int step) => $"at-{step}";

    /// <summary>Where in its slot the reel stops, 1 to <see cref="ReelLandings"/>: on the panel, per person, from the first step to the reveal.</summary>
    public static string Landing(int landing) => $"land-{landing}";

    /// <summary>One thing the draw could have given: a picture's class and a tier.</summary>
    private readonly record struct Decoy(string? Art, MomentTier Tier);

    private readonly LinkedList<Waiting> _unboxings = [];
    /// <summary>Who was here when the unboxing on screen began: the only people its beats are set for.</summary>
    private readonly HashSet<ulong> _watching = [];
    /// <summary>What each slot of the reel was last told, so the next reel only says what changes.</summary>
    private readonly Decoy?[] _reel = new Decoy?[ReelSlots];
    private Decoy? _prize;
    private string? _side;
    private Waiting? _unboxing;
    private ReelMode _mode;
    private bool _revealed;
    private bool _unboxResting;
    private int _landing;
    /// <summary>The step the strip stands at for everybody: 0 at rest.</summary>
    private int _step;
    private int _tests;
    private IClockTimer? _unboxTimer;
    private IClockTimer? _tickTimer;
    private IClockTimer? _stripTimer;

    /// <summary>How many unboxings are waiting for a stretch that fits them.</summary>
    public int UnboxingsWaiting => _unboxings.Count;

    /// <summary>Whether an unboxing is on screens now.</summary>
    public bool Unboxing => _unboxing is not null;

    /// <summary>The reel's switch (<c>ezpug_unbox_reel</c>): off, a drop with a reel is its line, its toast and its card. On for the life of the process unless an admin says otherwise.</summary>
    public bool ReelOn { get; private set; } = true;

    /// <summary>The reel's step on everybody's screen now, 0 at rest.</summary>
    public int ReelStep => _step;

    /// <summary>An admin flips the reel on or off, without a deploy. One line in the log either way.</summary>
    public void SwitchReel(bool on)
    {
        ReelOn = on;
        _log.Info(on
            ? "hud: the reel is on; a drop with a reel is unboxed where a stretch fits it"
            : "hud: the reel is off (ezpug_unbox_reel 0); a drop with a reel is its line, its toast and its card");
    }

    /// <summary>One line for <c>ezpug_status</c>: the reel's mode and switch, its schedule, and the addon stamp this server was built beside.</summary>
    public string ReelReport() =>
        $"{(ReelOn ? "steps" : "off (ezpug_unbox_reel 0: a drop is its line, toast and card)")}, {ReelSteps} steps over {Steps[^1]} ms of {ReelMs}, {StepMs} ms a step" +
        $"{(_unboxing is not null ? $", on screens now at step {_step} ({_mode.ToString().ToLowerInvariant()})" : "")}; stamp {HudStamp.Expected} expected on a client's card";

    // ------------------------------------------------------------------ the command

    private static IReadOnlyList<Decoy>? ReelOf(MomentCommand moment) =>
        moment.Reel is { Count: > 0 } reel
            ? [.. reel.Take(ProtocolConstants.MomentReelMax).Select(item => new Decoy(ArtClassOf(item.Art), item.Tier))]
            : null;

    /// <summary>
    /// The seed of a moment's reel: FNV-1a over what the moment says. The correlation id
    /// and <c>inMs</c> are the delivery's and stay out, so the same win told twice is the
    /// same reel.
    /// </summary>
    private static ulong SeedOf(MomentCommand moment)
    {
        var said = new StringBuilder()
            .Append(moment.Kind).Append('|')
            .Append(moment.SteamId64).Append('|')
            .Append(moment.Art).Append('|')
            .Append((int)moment.Tier);
        foreach (var item in moment.Reel ?? [])
        {
            said.Append('|').Append(item.Art).Append(':').Append((int)item.Tier);
        }

        return Fnv(said.ToString());
    }

    private static ulong Fnv(string text)
    {
        var hash = 14695981039346656037UL;
        foreach (var octet in Encoding.UTF8.GetBytes(text))
        {
            hash = (hash ^ octet) * 1099511628211UL;
        }

        return hash;
    }

    /// <summary>SplitMix64: a seed in, the same numbers out, on every server.</summary>
    private struct Draw(ulong seed)
    {
        private ulong _state = seed;

        public int Below(int bound)
        {
            _state += 0x9E3779B97F4A7C15UL;
            var z = _state;
            z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9UL;
            z = (z ^ (z >> 27)) * 0x94D049BB133111EBUL;
            return (int)((z ^ (z >> 31)) % (ulong)bound);
        }
    }

    // ------------------------------------------------------------------ whether, and when

    /// <summary>Whether an unboxing started this instant is over, with time to spare, before anybody plays again. Never in a decided round: the win panel is up, and its round start is asked instead.</summary>
    private bool UnboxStretch =>
        _hud.Spawned && _hud.Quiet is { } quiet && quiet.Reason != QuietReason.RoundOver && quiet.Fits(UnboxMs + UnboxSpareMs);

    /// <summary>What is left of the stretch, for a console line: the milliseconds, or why there is none.</summary>
    private string Left() => _hud.Quiet switch
    {
        null => "no stretch",
        { LeftMs: { } left } quiet => $"{quiet.Reason}, {left} ms left",
        { } quiet => $"{quiet.Reason}",
    };

    /// <summary>The winner's name as a label and a chat line may carry it: the player's on the server (a puppet's seat too), or the roster's.</summary>
    private string? NameOf(ulong steamId64) =>
        (_world.Find(steamId64)?.Name ?? _assignment?.ProfileOf(steamId64)?.Name) is { } name ? SaidLine.Sanitize(name) : null;

    /// <summary>
    /// A moment that is due, offered to the whole server. <c>true</c> when it is an
    /// unboxing and is on screens now or waits for its stretch; <c>false</c> when it is
    /// the caller's to show as a moment without a reel.
    /// </summary>
    private bool Unboxed(Told moment)
    {
        if (!_hud.On || moment.Kind != "drop" || moment.Reel is null || moment.About is not { } about || NameOf(about) is null)
        {
            return false;
        }

        if (!ReelOn)
        {
            _log.Info($"hud: the reel is off (ezpug_unbox_reel 0); the drop for {about} is its line, its toast and its card");
            return false;
        }

        var unboxing = new Waiting(moment, _world.Clock.NowMs);
        var busy = _unboxing is not null || _unboxResting || _unboxings.Count > 0;
        if (!busy && UnboxStretch)
        {
            Open(unboxing);
            return true;
        }

        if (!busy && _hud.Quiet is not { Reason: QuietReason.RoundOver })
        {
            _log.Info($"hud: no stretch fits the unboxing for {about} ({Left()}, {UnboxMs + UnboxSpareMs} ms wanted); it is shown without its reel");
            return false;
        }

        if (_unboxings.Count >= UnboxingsWaitingMax)
        {
            _log.Info($"hud: {UnboxingsWaitingMax} unboxings are already waiting; the drop for {about} is its line, its toast and its card");
            return false;
        }

        _unboxings.AddLast(unboxing);
        return true;
    }

    /// <summary>
    /// The next waiting unboxing, if none is up and the stretch fits it. A round start
    /// that does not fit one is a freeze too short for any: everything waiting is shown
    /// the old way, there and then.
    /// </summary>
    private void NextUnboxing(bool roundStart = false)
    {
        if (_unboxing is not null || _unboxResting)
        {
            return;
        }

        var now = _world.Clock.NowMs;
        while (_unboxings.First is { } first)
        {
            var stale = now - first.Value.DueAtMs > CardWaitMs;
            if (!stale && UnboxStretch)
            {
                _unboxings.RemoveFirst();
                Open(first.Value);
                return;
            }

            if (!stale && !roundStart)
            {
                return;
            }

            _unboxings.RemoveFirst();
            _log.Info(stale
                ? $"hud: the unboxing for {first.Value.Moment.About} waited more than {CardWaitMs / 1_000} s and is shown without its reel"
                : $"hud: this round's freeze does not fit the unboxing for {first.Value.Moment.About}; it is shown without its reel");
            Plain(first.Value.Moment);
        }
    }

    // ------------------------------------------------------------------ the diagnostic

    /// <summary>
    /// <c>ezpug_unbox_test</c>: a reel now, for whoever is on the server, about the first
    /// person here (a puppet's seat counts, so a server of puppets plays it too), with the
    /// steps a match plays or the old slide for a client to compare. It needs the layouts
    /// in the world and nothing else: no stretch, no match beat, no platform. The answer
    /// is one line for the console: what plays, for how many, and the stamp a client's
    /// card should show.
    /// </summary>
    public string PlayTest(ReelMode mode)
    {
        if (!_hud.On)
        {
            return "unbox test: the HUD is off on this server: " + (_hud.Addon is null
                ? "it booted without an addon id (EZPUG_HUD_ADDON)"
                : _assignment is null ? "no match is assigned" : "the match did not ask for a HUD (branding.hud)");
        }

        if (!_hud.Spawned)
        {
            return "unbox test: the layouts are not in the world yet: no round has started on this map";
        }

        if (_unboxing is not null)
        {
            return $"unbox test: an unboxing is on screens now (step {_step}); wait for it to be put away";
        }

        var about = (_world.Players.FirstOrDefault(player => !player.IsBot) ?? _world.Players.FirstOrDefault())?.SteamId64
            ?? _assignment?.Profiles.Keys.FirstOrDefault();
        if (about is not { } who || NameOf(who) is not { } name)
        {
            return "unbox test: nobody is on the server and nobody is rostered, so there is no name to call";
        }

        var run = ++_tests;
        var told = new Told(
            "drop",
            who,
            MomentTier.Legendary,
            ArtClassOf("big-jersey"),
            new Words($"{name} zieht: BIG Trikot (Testlauf {run})", $"Du ziehst: BIG Trikot (Testlauf {run})"),
            new Words($"{name} wins: BIG jersey (test run {run})", $"You win: BIG jersey (test run {run})"),
            [
                new Decoy(ArtClassOf("category-skin"), MomentTier.Common),
                new Decoy(ArtClassOf("category-merch"), MomentTier.Uncommon),
                new Decoy(ArtClassOf("double-xp"), MomentTier.Rare),
                new Decoy(ArtClassOf("big-cap"), MomentTier.Legendary),
            ],
            Fnv($"ezpug_unbox_test|{who}|{run}"));
        Open(new Waiting(told, _world.Clock.NowMs), mode, $"ezpug_unbox_test {mode.ToString().ToLowerInvariant()}");
        return $"unbox test: playing the {(mode == ReelMode.Steps ? "stepped reel" : "old slide")} for {name} to {_watching.Count} watching, " +
            $"{Left()}; the prize shows in {RevealMs} ms. This server was built beside addon stamp {HudStamp.Expected}: the reel's window and the welcome card show the stamp the client mounted";
    }

    // ------------------------------------------------------------------ the three beats

    /// <summary>The call: the reel is laid out for everybody, and everybody here is shown the panel.</summary>
    private void Open(Waiting unboxing, ReelMode mode = ReelMode.Steps, string? note = null)
    {
        var moment = unboxing.Moment;
        var about = moment.About!.Value;
        var name = NameOf(about) ?? "";
        _unboxing = unboxing;
        _mode = mode;
        _revealed = false;
        // A strip still on its way back from the last reel (put away a moment ago) goes
        // back now, under the panel's fade-in, so the call stands over a reel at rest.
        StripBack();
        LayOut(moment);
        _hud.SetVariable(Layout, UnboxName, Text, name);
        var side = _world.Find(about)?.Team switch
        {
            PlayerTeam.CounterTerrorist => SideCt,
            PlayerTeam.Terrorist => SideT,
            _ => null,
        };
        if (_side != side)
        {
            if (_side is not null)
            {
                _hud.SetClass(Layout, Unbox, _side, false);
            }

            if (side is not null)
            {
                _hud.SetClass(Layout, Unbox, side, true);
            }

            _side = side;
        }

        var room = SaidLine.MaxLength - _brand.Prefix.EnumerateRunes().Count() - 1;
        _watching.Clear();
        foreach (var player in _world.Players)
        {
            if (player.IsBot)
            {
                continue;
            }

            var locale = LocaleOf(player);
            var call = _localizer().For(locale)[CallKey];
            _watching.Add(player.SteamId64);
            _hud.SetVariable(player, Layout, UnboxCall, Text, call);
            _hud.SetVariable(player, Layout, UnboxLine, Text, player.SteamId64 == about ? moment.In(locale).You : moment.In(locale).Everyone);
            _hud.SetClass(player, Layout, Unbox, Shown, true);
            _brand.Say(player, SaidLine.Fit($"{name} {call}", room));
        }

        _log.Info($"hud: unboxing for {about} ({Left()}), {_watching.Count} watching; the prize shows in {RevealMs} ms{(note is null ? "" : $" ({note})")}");
        _unboxTimer = _world.Clock.After(CallMs, Roll);
    }

    /// <summary>The reel: its landing for everybody watching, then the steps on their schedule, and the reveal at the contract's instant.</summary>
    private void Roll()
    {
        foreach (var watcher in Watching())
        {
            _hud.SetClass(watcher, Layout, Unbox, Landing(_landing), true);
            if (_mode == ReelMode.Slide)
            {
                _hud.SetClass(watcher, Layout, Unbox, Slide, true);
            }
        }

        _log.Info($"hud: the unboxing for {_unboxing!.Moment.About} rolls to landing {_landing} ({(_mode == ReelMode.Steps ? $"{ReelSteps} steps" : "the old slide")})");
        _tickTimer = _world.Clock.After(Steps[0], Step);
        _unboxTimer = _world.Clock.After(ReelMs, Reveal);
    }

    /// <summary>One step: the next slot under the marker for everybody (the class before it off in the same frame), one tick for everybody watching, and the next step timed.</summary>
    private void Step()
    {
        var step = _step + 1;
        if (_mode == ReelMode.Steps)
        {
            // The new step first, then the old one off: with both on, the later rule in
            // the sheet wins, so the strip never aims at its resting place in between.
            _hud.SetClass(Layout, Unbox, StepClass(step), true);
            if (_step > 0)
            {
                _hud.SetClass(Layout, Unbox, StepClass(_step), false);
            }
        }

        _step = step;
        foreach (var watcher in Watching())
        {
            _world.PlaySound(watcher, TickSound, TickVolume);
        }

        _tickTimer = step < ReelSteps ? _world.Clock.After(Steps[step] - Steps[step - 1], Step) : null;
    }

    /// <summary>The reveal: the prize, its sound, and the line, which nobody was told before.</summary>
    private void Reveal()
    {
        var moment = _unboxing!.Moment;
        _revealed = true;
        _log.Info($"hud: the unboxing for {moment.About} shows its prize ({moment.Tier.ToString().ToLowerInvariant()}) and says its line");
        foreach (var watcher in Watching())
        {
            _hud.SetClass(watcher, Layout, Unbox, Landing(_landing), false);
            _hud.SetClass(watcher, Layout, Unbox, Revealed, true);
            _world.PlaySound(watcher, RevealSoundOf(moment.Tier), watcher.SteamId64 == moment.About ? 1f : RevealVolume);
        }

        Say(moment, PersonOf(moment));
        _unboxTimer = _world.Clock.After(PrizeMs, () =>
        {
            Close("its prize was shown");
            _unboxResting = true;
            _unboxTimer = _world.Clock.After(UnboxRestMs, () =>
            {
                _unboxTimer = null;
                _unboxResting = false;
                NextUnboxing();
            });
        });
    }

    /// <summary>Everybody who was here when it began and still is.</summary>
    private List<IGamePlayer> Watching() =>
        [.. _watching.Select(_world.Find).OfType<IGamePlayer>().Where(player => !player.IsBot)];

    /// <summary>
    /// The reel for everybody: the prize in the slot it stops on, and in every other one
    /// of the decoys, never the same twice running where the reel has two. Only what
    /// differs from the reel before is said.
    /// </summary>
    private void LayOut(Told moment)
    {
        var draw = new Draw(moment.Seed);
        var reel = moment.Reel!;
        var prize = new Decoy(Art(moment.Art), moment.Tier);
        var last = -1;
        for (var slot = 1; slot <= ReelSlots; slot++)
        {
            Decoy item;
            if (slot == ReelStopSlot)
            {
                item = prize;
                last = -1;
            }
            else
            {
                var pick = draw.Below(reel.Count);
                if (pick == last && reel.Count > 1)
                {
                    pick = (pick + 1) % reel.Count;
                }

                last = pick;
                item = reel[pick] with { Art = Art(reel[pick].Art) };
            }

            Dress(ReelSlot(slot), _reel[slot - 1], item);
            _reel[slot - 1] = item;
        }

        Dress(Unbox, _prize, prize);
        _prize = prize;
        _landing = 1 + draw.Below(ReelLandings);
    }

    /// <summary>A picture and a tier on a panel, for everybody, over what it carried before.</summary>
    private void Dress(string panel, Decoy? before, Decoy item)
    {
        if (before is not { } was)
        {
            // Nothing was ever set on it, so there is nothing to take off: one line a
            // slot, not one per tier, in the frame that lays out a match's first reel.
            _hud.SetClass(Layout, panel, TierClassOf(item.Tier), true);
        }
        else if (was.Tier != item.Tier)
        {
            _hud.SetClass(Layout, panel, TierClassOf(was.Tier), false);
            _hud.SetClass(Layout, panel, TierClassOf(item.Tier), true);
        }

        if (before?.Art == item.Art)
        {
            return;
        }

        if (before?.Art is { } old)
        {
            _hud.SetClass(Layout, panel, old, false);
        }

        if (item.Art is { } art)
        {
            _hud.SetClass(Layout, panel, art, true);
        }
    }

    // ------------------------------------------------------------------ gone

    /// <summary>Every beat off every screen it was on, in one frame: the stylesheet fades the panel whatever the reel is doing. The step class follows once the panel has faded.</summary>
    private void Close(string why)
    {
        _log.Info($"hud: the unboxing for {_unboxing?.Moment.About} is put away: {why}");
        foreach (var watcher in Watching())
        {
            _hud.SetClass(watcher, Layout, Unbox, Shown, false);
            _hud.SetClass(watcher, Layout, Unbox, Landing(_landing), false);
            _hud.SetClass(watcher, Layout, Unbox, Revealed, false);
            if (_mode == ReelMode.Slide)
            {
                _hud.SetClass(watcher, Layout, Unbox, Slide, false);
            }
        }

        _unboxTimer?.Cancel();
        _unboxTimer = null;
        _tickTimer?.Cancel();
        _tickTimer = null;
        _unboxing = null;
        _watching.Clear();
        if (_step > 0)
        {
            _stripTimer?.Cancel();
            _stripTimer = _world.Clock.After(StripBackMs, StripBack);
        }
    }

    /// <summary>The strip back to its start for everybody: the step class off, which the strip's own short slide takes it home by.</summary>
    private void StripBack()
    {
        _stripTimer?.Cancel();
        _stripTimer = null;
        if (_step > 0)
        {
            _hud.SetClass(Layout, Unbox, StepClass(_step), false);
            _step = 0;
        }
    }

    /// <summary>Somebody is playing. An unboxing that had not shown its prize told nobody anything: it becomes the moment it would have been without a reel.</summary>
    private void PutAwayUnboxing()
    {
        if (_unboxing is not { } unboxing)
        {
            return;
        }

        Close(_revealed ? "somebody is playing" : "somebody is playing before its prize, so it is shown without its reel");
        if (!_revealed)
        {
            Plain(unboxing.Moment);
        }
    }

    /// <summary>A map change: the one on screen and the ones waiting go with the map, and a line nobody has read yet is said.</summary>
    private void OnMapStartedUnboxing()
    {
        var unsaid = _unboxings.Select(waiting => waiting.Moment).ToList();
        if (_unboxing is { } unboxing)
        {
            Close("the map changed");
            if (!_revealed)
            {
                unsaid.Insert(0, unboxing.Moment);
            }
        }

        _unboxTimer?.Cancel();
        _unboxTimer = null;
        _unboxResting = false;
        _unboxings.Clear();
        foreach (var moment in unsaid)
        {
            Say(moment, PersonOf(moment));
        }
    }

    private void StopUnboxing()
    {
        _unboxTimer?.Cancel();
        _unboxTimer = null;
        _tickTimer?.Cancel();
        _tickTimer = null;
        _stripTimer?.Cancel();
        _stripTimer = null;
        _unboxing = null;
        _unboxResting = false;
        _revealed = false;
        _step = 0;
        _unboxings.Clear();
        _watching.Clear();
        // The HUD forgets what everybody was told; so does this.
        Array.Clear(_reel);
        _prize = null;
        _side = null;
    }
}
