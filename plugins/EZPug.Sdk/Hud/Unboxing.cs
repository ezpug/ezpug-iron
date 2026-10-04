using System.Text;
using EZPug.Sdk.Protocol;

namespace EZPug.Sdk;

/// <summary>
/// <b>The unboxing</b> (PRD-08 T4): a drop about somebody that carries a reel is the one
/// moment the whole server watches. The call ("Ada hat einen Drop! Mal sehen…"), a reel
/// of the decoys that slows and stops on the prize, then the reveal, on the last panel of
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
/// <see cref="PrizeMs"/> later. <b>The line is said at the reveal</b>, not before: chat is
/// on every screen, and a line that names the prize would open the box before the reel
/// stopped.</item>
/// <item><b>The same moment, the same reel.</b> The slots and the landing come from a
/// seed over what the moment says (never its correlation id), so a redelivered command
/// shows what the first one did. The prize is in <see cref="ReelStopSlot"/>.</item>
/// <item><b>Put away at once.</b> The instant somebody is playing every class comes off.
/// If the prize had not shown yet, nobody knows what was won: the line, the toast and the
/// card follow in that instant, as for a moment that never had a reel.</item>
/// <item><b>One at a time.</b> A second unboxing waits for the next stretch that fits,
/// at most <see cref="UnboxingsWaitingMax"/> of them and each no longer than
/// <see cref="CardWaitMs"/>; one that waited too long is shown the old way.</item>
/// <item><b>Whoever was there when it began.</b> The beats are each person's own classes,
/// so somebody who connects in the middle sees nothing of it (and reads the line), and a
/// spectator sees what the player they watch sees. The reel's pictures and the name are
/// everybody's, and invisible to whoever is not shown the panel.</item>
/// <item><b>The winner need not be here.</b> The name is the player's on the server, or
/// the roster's; a puppet's seat counts. A drop about somebody this server has no name
/// for is a moment without a reel.</item>
/// <item><b>A map change</b> takes the one on screen and the ones waiting; a line that
/// was never said is said. <b>A release</b> takes everything, silently.</item>
/// </list>
/// </summary>
public sealed partial class Moments
{
    /// <summary>How many slots the reel has (<c>unbox_slot_1</c> onwards).</summary>
    public const int ReelSlots = 36;

    /// <summary>The slot the reel stops on, and so the prize's: the stylesheet's rolled position puts it under the marker.</summary>
    public const int ReelStopSlot = 33;

    /// <summary>How many places within its slot the reel may stop at (<c>land-1</c> onwards).</summary>
    public const int ReelLandings = 4;

    /// <summary>How long the call stands before the reel moves: long enough to read a name and six words.</summary>
    public const long CallMs = 2_000;

    /// <summary>How long the reel slides: the stylesheet's transition, to the millisecond.</summary>
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

    /// <summary>The unboxing's panel: the beats, per person; the prize's tier, picture and the winner's side, for everybody.</summary>
    public const string Unbox = "unbox";

    /// <summary>The winner's name.</summary>
    public const string UnboxName = "unbox_name";

    /// <summary>The call under the name, in the reader's language.</summary>
    public const string UnboxCall = "unbox_call";

    /// <summary>The line under the prize: the item's, and the winner's own for the winner.</summary>
    public const string UnboxLine = "unbox_line";

    /// <summary>On the panel: the reel is sliding, or has stopped.</summary>
    public const string Rolling = "rolling";

    /// <summary>On the panel: the prize is out.</summary>
    public const string Revealed = "revealed";

    /// <summary>On the panel: the winner plays CT, or T. Neither is nobody's side.</summary>
    public const string SideCt = "side-ct";

    /// <inheritdoc cref="SideCt"/>
    public const string SideT = "side-t";

    /// <summary>The key of the call in the SDK's catalog.</summary>
    public const string CallKey = "hud.unbox.call";

    /// <summary>A slot of the reel, 1 to <see cref="ReelSlots"/> from the left: a picture and a tier, for everybody.</summary>
    public static string ReelSlot(int slot) => $"unbox_slot_{slot}";

    /// <summary>Where in its slot the reel stops, 1 to <see cref="ReelLandings"/>: on the panel, with <see cref="Rolling"/>.</summary>
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
    private bool _revealed;
    private bool _unboxResting;
    private int _landing;
    private IClockTimer? _unboxTimer;

    /// <summary>How many unboxings are waiting for a stretch that fits them.</summary>
    public int UnboxingsWaiting => _unboxings.Count;

    /// <summary>Whether an unboxing is on screens now.</summary>
    public bool Unboxing => _unboxing is not null;

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

        var hash = 14695981039346656037UL;
        foreach (var octet in Encoding.UTF8.GetBytes(said.ToString()))
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

        var unboxing = new Waiting(moment, _world.Clock.NowMs);
        var busy = _unboxing is not null || _unboxResting || _unboxings.Count > 0;
        if (!busy && UnboxStretch)
        {
            Open(unboxing);
            return true;
        }

        if (!busy && _hud.Quiet is not { Reason: QuietReason.RoundOver })
        {
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

    // ------------------------------------------------------------------ the three beats

    /// <summary>The call: the reel is laid out for everybody, and everybody here is shown the panel.</summary>
    private void Open(Waiting unboxing)
    {
        var moment = unboxing.Moment;
        var about = moment.About!.Value;
        var name = NameOf(about) ?? "";
        _unboxing = unboxing;
        _revealed = false;
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

        _log.Info($"hud: unboxing for {about}, {_watching.Count} watching; the prize shows in {RevealMs} ms");
        _unboxTimer = _world.Clock.After(CallMs, Roll);
    }

    /// <summary>The reel: it slides for <see cref="ReelMs"/> and stops where this moment's seed says.</summary>
    private void Roll()
    {
        foreach (var watcher in Watching())
        {
            _hud.SetClass(watcher, Layout, Unbox, Landing(_landing), true);
            _hud.SetClass(watcher, Layout, Unbox, Rolling, true);
        }

        _unboxTimer = _world.Clock.After(ReelMs, Reveal);
    }

    /// <summary>The reveal: the prize, its sound, and the line, which nobody was told before.</summary>
    private void Reveal()
    {
        var moment = _unboxing!.Moment;
        _revealed = true;
        foreach (var watcher in Watching())
        {
            _hud.SetClass(watcher, Layout, Unbox, Landing(_landing), false);
            _hud.SetClass(watcher, Layout, Unbox, Revealed, true);
            _world.PlaySound(watcher, Sound, VolumeOf(moment.Tier));
        }

        Say(moment, PersonOf(moment));
        _unboxTimer = _world.Clock.After(PrizeMs, () =>
        {
            Close();
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

    /// <summary>Every beat off every screen it was on, in one frame: the stylesheet fades the panel whatever the reel is doing.</summary>
    private void Close()
    {
        foreach (var watcher in Watching())
        {
            _hud.SetClass(watcher, Layout, Unbox, Shown, false);
            _hud.SetClass(watcher, Layout, Unbox, Rolling, false);
            _hud.SetClass(watcher, Layout, Unbox, Landing(_landing), false);
            _hud.SetClass(watcher, Layout, Unbox, Revealed, false);
        }

        _unboxTimer?.Cancel();
        _unboxTimer = null;
        _unboxing = null;
        _watching.Clear();
    }

    /// <summary>Somebody is playing. An unboxing that had not shown its prize told nobody anything: it becomes the moment it would have been without a reel.</summary>
    private void PutAwayUnboxing()
    {
        if (_unboxing is not { } unboxing)
        {
            return;
        }

        Close();
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
            Close();
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
        _unboxing = null;
        _unboxResting = false;
        _revealed = false;
        _unboxings.Clear();
        _watching.Clear();
        // The HUD forgets what everybody was told; so does this.
        Array.Clear(_reel);
        _prize = null;
        _side = null;
    }
}
