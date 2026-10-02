using System.Text.RegularExpressions;
using EZPug.Sdk.Protocol;

namespace EZPug.Sdk;

/// <summary>
/// <b>The moment</b> (decision 34, PRD-07 T6): the platform says "this happened to this
/// player" and the server decides how and when to show it. The command names a kind, a
/// person, a tier, a picture key and the words; everything about panels, classes and
/// timing is here, and nothing of it is in the Match API.
///
/// <para><b>The line, always.</b> When the moment is due (<c>inMs</c> after it arrived)
/// everybody reads its line in chat behind the match's prefix, each in the language of
/// their roster entry, the person it is about in the words written for them. That is the
/// whole of a moment on a server that draws nothing, and on one that does it is what a
/// player without the addon gets. With the HUD off not one call below this paragraph
/// reaches the world.</para>
///
/// <para><b>The toast</b>, with the HUD on: a slim line for everybody at the same
/// instant, tinted by tier, on one of <see cref="ToastRows"/> rows for
/// <see cref="ToastMs"/>. A toast that finds every row taken waits for the first one to
/// come free, and past <see cref="ToastsWaitingMax"/> waiting it is not shown: the line
/// was said.</para>
///
/// <para><b>The card</b>, for the person: it slides in face down, turns over
/// <see cref="TurnMs"/> later with the game's own item sound, louder with the tier, and
/// is gone <see cref="CardMs"/> after it came. <b>The timing rule</b>, which
/// <c>MomentTests</c> holds as a table on the fake clock:</para>
/// <list type="bullet">
/// <item>A card needs a stretch of nobody playing long enough to finish
/// (<see cref="Hud.Quiet"/> fits <see cref="CardMs"/>, and the layouts are in the world).
/// When the moment is due in one, the card plays now and the person gets no toast: the
/// card says it.</item>
/// <item>When it is not (a round is being played, the freeze is nearly over, the mode's
/// freeze is too short) the line and the toast go out anyway, the person's too, and the
/// card waits for the next such stretch: a round start, a round end, the map's end.</item>
/// <item>A card that has waited longer than <see cref="CardWaitMs"/> is dropped, and so
/// is every waiting card at a map change.</item>
/// <item>The instant somebody is playing (the freeze ends, or a round starts without
/// one) a card on screen is put away. One that had not turned over yet showed nothing,
/// and waits again.</item>
/// <item>Two moments for one person queue: one card at a time, <see cref="CardRestMs"/>
/// apart so the second one slides in rather than swapping its words, at most
/// <see cref="CardsWaitingMax"/> waiting.</item>
/// <item>Somebody who is not on the server when the moment is due gets nothing, and
/// somebody who leaves takes their waiting cards with them. A bot and a puppet have no
/// screen.</item>
/// </list>
///
/// <para>The layout is <c>hud/layout/ezpug_moment.xml</c> (PRD-07 T7); this class names
/// its panels and classes and nothing else does. The picture is a class
/// (<c>art-&lt;key&gt;</c>) because nothing can put a picture on a screen at runtime: a
/// key the addon holds no rule for is the default picture on the client, without this
/// class knowing the list.</para>
/// </summary>
public sealed partial class Moments
{
    /// <summary>The layout, by its source path in the addon.</summary>
    public const string Layout = "panorama/layout/custom_game/ezpug_moment.xml";

    /// <summary>How many toasts are on a screen at once.</summary>
    public const int ToastRows = 3;

    /// <summary>How long a toast stays.</summary>
    public const long ToastMs = 6_000;

    /// <summary>How long a row stays empty before the next toast takes it, so the next one comes in rather than swapping the words of the last.</summary>
    public const long ToastRestMs = 500;

    /// <summary>How many toasts wait for a row before the next one is not shown at all.</summary>
    public const int ToastsWaitingMax = 6;

    /// <summary>How long the card is on screen, and so the stretch of nobody playing it needs.</summary>
    public const long CardMs = 6_000;

    /// <summary>How long after it slides in the card turns over and the sound plays.</summary>
    public const long TurnMs = 1_000;

    /// <summary>The gap between two cards for one person.</summary>
    public const long CardRestMs = 500;

    /// <summary>How long a card waits for a stretch of nobody playing before it is dropped: longer than a round can run, shorter than anybody remembers the line.</summary>
    public const long CardWaitMs = 180_000;

    /// <summary>How many cards wait for one person before the next one is not queued.</summary>
    public const int CardsWaitingMax = 4;

    /// <summary>How many different pictures one match may name. A key is open in the contract, and every class a slot was ever told is told again at each spawn.</summary>
    public const int ArtClassesMax = 64;

    /// <summary>The card's panel: <see cref="Shown"/>, <see cref="Turned"/>, a tier and a picture, each for one person.</summary>
    public const string Card = "moment_card";

    /// <summary>The card's heading: what kind of moment it is, in the person's language.</summary>
    public const string CardKind = "moment_card_kind";

    /// <summary>The card's words: the person's own line.</summary>
    public const string CardText = "moment_card_text";

    /// <summary>On the card and on a toast: on screen.</summary>
    public const string Shown = "shown";

    /// <summary>On the card: face up.</summary>
    public const string Turned = "turned";

    /// <summary>A tier is <c>tier-&lt;name&gt;</c> on the card (one person's) and on a toast's row (everybody's).</summary>
    public const string TierClassPrefix = "tier-";

    /// <summary>A picture is <c>art-&lt;key&gt;</c> on the card; no class is the default picture.</summary>
    public const string ArtClassPrefix = "art-";

    /// <summary>The default picture's key (<c>HUD_DEFAULT_ART_KEY</c>): never a class, it is what no class shows.</summary>
    public const string DefaultArt = "empty";

    /// <summary>Every label binds <c>{s:text}</c>, set on the label's own id.</summary>
    public const string Text = "text";

    /// <summary>
    /// The one sound, the game's own: what CS2 plays at the end of a match when the item
    /// that dropped is yours (<c>sounds/ui/item_drop_personal.vsnd</c>, in
    /// <c>soundevents/game_sounds_ui.vsndevts</c>). Nothing ships in the addon.
    /// </summary>
    public const string Sound = "EndMatch.ItemRevealSingleLocalPlayer";

    /// <summary>The kinds this server dresses with a heading of their own (<c>MOMENT_KINDS</c>); any other kind is headed by the event's name.</summary>
    public static readonly IReadOnlyList<string> Kinds = ["drop", "perk", "raffle"];

    private static readonly MomentTier[] Tiers = Enum.GetValues<MomentTier>();

    /// <summary>A toast's row, 1 to <see cref="ToastRows"/> from the top: its panel carries <see cref="Shown"/> for each person and the tier for everybody.</summary>
    public static string Toast(int row) => $"moment_toast_{row}";

    /// <summary>The label of a toast's row.</summary>
    public static string ToastText(int row) => $"moment_toast_{row}_text";

    /// <summary>The class a tier puts on the card and on a toast's row.</summary>
    public static string TierClassOf(MomentTier tier) =>
        TierClassPrefix + tier switch
        {
            MomentTier.Uncommon => "uncommon",
            MomentTier.Rare => "rare",
            MomentTier.Legendary => "legendary",
            _ => "common",
        };

    /// <summary>How loud <see cref="Sound"/> plays: the same sound for every tier, louder the more it matters.</summary>
    public static float VolumeOf(MomentTier tier) =>
        tier switch
        {
            MomentTier.Uncommon => 0.6f,
            MomentTier.Rare => 0.8f,
            MomentTier.Legendary => 1f,
            _ => 0.4f,
        };

    /// <summary>The class a picture key puts on the card, or <c>null</c> for the default picture: no key, the default's own, or one outside the contract's grammar.</summary>
    public static string? ArtClassOf(string? art) =>
        art is { Length: <= 64 } key && key != DefaultArt && Key().IsMatch(key) ? ArtClassPrefix + key : null;

    /// <summary>The contract's grammar for a picture key (<c>hudKeySchema</c>).</summary>
    [GeneratedRegex("^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$")]
    private static partial Regex Key();

    /// <summary>One language's two lines, as they may be said.</summary>
    private readonly record struct Words(string Everyone, string You);

    /// <summary>A moment as the server holds it: what the command said, cleaned.</summary>
    private sealed record Told(string Kind, ulong? About, MomentTier Tier, string? Art, Words German, Words English)
    {
        public Words In(Locale locale) => locale == Locale.En ? English : German;
    }

    /// <summary>A card and the instant its moment was due, which is what the cap counts from.</summary>
    private sealed record Waiting(Told Moment, long DueAtMs);

    /// <summary>One person's cards: the one on screen, the ones behind it, and the timer of whatever comes next.</summary>
    private sealed class Seat
    {
        public LinkedList<Waiting> Queue { get; } = [];
        public Waiting? Showing { get; set; }
        public bool Turned { get; set; }
        public bool Resting { get; set; }
        public IClockTimer? Timer { get; set; }
        /// <summary>The picture class this person's card last carried, taken off before the next one's goes on.</summary>
        public string? Art { get; set; }
    }

    private sealed class Row
    {
        public bool Taken { get; set; }
        public IClockTimer? Timer { get; set; }
    }

    private readonly IGameWorld _world;
    private readonly Hud _hud;
    private readonly Branding _brand;
    private readonly Func<Localizer> _localizer;
    private readonly ILinkLog _log;
    private readonly HashSet<IClockTimer> _due = [];
    private readonly Dictionary<ulong, Seat> _seats = [];
    private readonly Row[] _rows = [.. Enumerable.Range(0, ToastRows).Select(_ => new Row())];
    private readonly Queue<(MomentTier Tier, Func<IGamePlayer, string?> Words)> _toasts = new();
    private readonly HashSet<string> _arts = [];
    private Assignment? _assignment;

    public Moments(IGameWorld world, Hud hud, Branding brand, Func<Localizer> localizer, ILinkLog? log = null)
    {
        _world = world;
        _hud = hud;
        _brand = brand;
        _localizer = localizer;
        _log = log ?? NullLinkLog.Instance;
        // A spectator is shown the moment as the player they watch sees it.
        hud.Register(Layout, observable: true);
    }

    /// <summary>How many cards are waiting for a stretch of nobody playing, over everybody.</summary>
    public int CardsWaiting => _seats.Values.Sum(seat => seat.Queue.Count);

    // ------------------------------------------------------------------ the command

    /// <summary>
    /// A <c>moment</c> arrived. The answer does not wait for it: <c>applied</c> means the
    /// server holds the moment, and a release before it is due takes it along. A line of
    /// which nothing survives being said in chat is refused, as an <c>announce</c> is.
    /// </summary>
    public CommandAnswer OnCommand(MomentCommand moment)
    {
        if (WordsOf(moment.Text.De) is not { } german || WordsOf(moment.Text.En) is not { } english)
        {
            return CommandAnswer.Rejected(MatchApiErrorCode.ValidationFailed, "nothing of that line survives being said in chat");
        }

        var told = new Told(
            moment.Kind,
            ulong.TryParse(moment.SteamId64, out var steamId64) ? steamId64 : null,
            moment.Tier,
            ArtClassOf(moment.Art),
            german,
            english);
        if (moment.InMs <= 0)
        {
            Due(told);
            return CommandAnswer.Applied;
        }

        IClockTimer? timer = null;
        timer = _world.Clock.After(moment.InMs, () =>
        {
            _due.Remove(timer!);
            Due(told);
        });
        _due.Add(timer);
        return CommandAnswer.Applied;

        // The person reads everybody's line where none was written for them.
        static Words? WordsOf(MomentWords words)
        {
            if (SaidLine.Sanitize(words.Everyone) is not { } everyone)
            {
                return null;
            }

            if (words.You is null)
            {
                return new Words(everyone, everyone);
            }

            return SaidLine.Sanitize(words.You) is { } you ? new Words(everyone, you) : null;
        }
    }

    /// <summary>The moment is due: the line, and with the HUD on the toast and the person's card, now or at the next stretch of nobody playing.</summary>
    private void Due(Told moment)
    {
        var person = moment.About is { } about && _world.Find(about) is { IsBot: false } present ? present : null;
        // The client's words behind the match's prefix, and the whole of it one chat line.
        var room = SaidLine.MaxLength - _brand.Prefix.EnumerateRunes().Count() - 1;
        foreach (var player in _world.Players)
        {
            if (!player.IsBot)
            {
                _brand.Say(player, SaidLine.Fit(LineFor(moment, player, person), room));
            }
        }

        if (!_hud.On)
        {
            return;
        }

        var playing = person is not null && Offer(person, moment);
        Raise(moment.Tier, player => playing && player.SteamId64 == person!.SteamId64 ? null : LineFor(moment, player, person));
    }

    private string LineFor(Told moment, IGamePlayer reader, IGamePlayer? person)
    {
        var words = moment.In(LocaleOf(reader));
        return person is not null && reader.SteamId64 == person.SteamId64 ? words.You : words.Everyone;
    }

    private Locale LocaleOf(IGamePlayer player) => _assignment?.LocaleOf(player.SteamId64) ?? Localizer.DefaultLocale;

    // ------------------------------------------------------------------ the toast

    /// <summary>
    /// A toast for everybody <paramref name="words"/> has a line for, on the first free
    /// row. The tier is the row's, for everybody; the words and whether the row is shown
    /// are each person's, so somebody who connects while it is up sees an empty screen
    /// and not an empty toast.
    /// </summary>
    private void Raise(MomentTier tier, Func<IGamePlayer, string?> words)
    {
        var free = Array.FindIndex(_rows, row => !row.Taken);
        if (free >= 0)
        {
            Raise(free, tier, words);
        }
        else if (_toasts.Count < ToastsWaitingMax)
        {
            _toasts.Enqueue((tier, words));
        }
    }

    private void Raise(int index, MomentTier tier, Func<IGamePlayer, string?> words)
    {
        var row = _rows[index];
        var panel = Toast(index + 1);
        row.Taken = true;
        foreach (var each in Tiers)
        {
            _hud.SetClass(Layout, panel, TierClassOf(each), each == tier);
        }

        foreach (var player in _world.Players)
        {
            if (!player.IsBot && words(player) is { } line)
            {
                _hud.SetVariable(player, Layout, ToastText(index + 1), Text, line);
                _hud.SetClass(player, Layout, panel, Shown, true);
            }
        }

        row.Timer = _world.Clock.After(ToastMs, () =>
        {
            foreach (var player in _world.Players)
            {
                if (!player.IsBot)
                {
                    _hud.SetClass(player, Layout, panel, Shown, false);
                }
            }

            row.Timer = _world.Clock.After(ToastRestMs, () =>
            {
                row.Timer = null;
                row.Taken = false;
                if (_toasts.TryDequeue(out var next))
                {
                    Raise(index, next.Tier, next.Words);
                }
            });
        });
    }

    // ------------------------------------------------------------------ the card

    /// <summary>Whether a card started this instant is over before anybody plays again, on layouts that are in the world.</summary>
    private bool Stretch => _hud.Spawned && _hud.Quiet is { } quiet && quiet.Fits(CardMs);

    /// <summary>A card for somebody who is here. <c>true</c> when it is on their screen now; otherwise it waits behind their others, or for the next stretch, or was one too many.</summary>
    private bool Offer(IGamePlayer person, Told moment)
    {
        if (!_seats.TryGetValue(person.SteamId64, out var seat))
        {
            seat = new Seat();
            _seats[person.SteamId64] = seat;
        }

        if (seat.Queue.Count >= CardsWaitingMax)
        {
            _log.Info($"hud: {CardsWaitingMax} cards are already waiting for {person.SteamId64}; this moment is its line and its toast");
            return false;
        }

        var card = new Waiting(moment, _world.Clock.NowMs);
        seat.Queue.AddLast(card);
        Next(person.SteamId64);
        return ReferenceEquals(seat.Showing, card);
    }

    /// <summary>The person's next card, if they have one, none is up and nobody is playing for long enough.</summary>
    private void Next(ulong steamId64)
    {
        if (!_seats.TryGetValue(steamId64, out var seat) || seat.Showing is not null || seat.Resting)
        {
            return;
        }

        var now = _world.Clock.NowMs;
        while (seat.Queue.First is { } stale && now - stale.Value.DueAtMs > CardWaitMs)
        {
            seat.Queue.RemoveFirst();
            _log.Info($"hud: a card for {steamId64} waited more than {CardWaitMs / 1_000} s for nobody to be playing and is dropped");
        }

        if (seat.Queue.First is not { } first || !Stretch || _world.Find(steamId64) is not { IsBot: false } person)
        {
            return;
        }

        seat.Queue.RemoveFirst();
        Play(person, seat, first.Value);
    }

    private void NextForEverybody()
    {
        foreach (var steamId64 in _seats.Keys.ToList())
        {
            Next(steamId64);
        }
    }

    private void Play(IGamePlayer person, Seat seat, Waiting card)
    {
        var moment = card.Moment;
        var locale = LocaleOf(person);
        var steamId64 = person.SteamId64;
        seat.Showing = card;
        seat.Turned = false;
        _hud.SetVariable(person, Layout, CardKind, Text, Heading(moment.Kind, locale));
        _hud.SetVariable(person, Layout, CardText, Text, moment.In(locale).You);
        foreach (var each in Tiers)
        {
            _hud.SetClass(person, Layout, Card, TierClassOf(each), each == moment.Tier);
        }

        var art = Art(moment.Art);
        if (seat.Art is { } last && last != art)
        {
            _hud.SetClass(person, Layout, Card, last, false);
        }

        seat.Art = art;
        if (art is not null)
        {
            _hud.SetClass(person, Layout, Card, art, true);
        }

        _hud.SetClass(person, Layout, Card, Turned, false);
        _hud.SetClass(person, Layout, Card, Shown, true);
        seat.Timer = _world.Clock.After(TurnMs, () =>
        {
            seat.Turned = true;
            if (_world.Find(steamId64) is { IsBot: false } still)
            {
                _hud.SetClass(still, Layout, Card, Turned, true);
                _world.PlaySound(still, Sound, VolumeOf(moment.Tier));
            }

            seat.Timer = _world.Clock.After(CardMs - TurnMs, () =>
            {
                Hide(steamId64);
                seat.Showing = null;
                seat.Resting = true;
                seat.Timer = _world.Clock.After(CardRestMs, () =>
                {
                    seat.Timer = null;
                    seat.Resting = false;
                    Next(steamId64);
                });
            });
        });
    }

    /// <summary>The picture's class, unless this match has already named more different pictures than a slot should be told about.</summary>
    private string? Art(string? art)
    {
        if (art is null || _arts.Contains(art))
        {
            return art;
        }

        if (_arts.Count >= ArtClassesMax)
        {
            return null;
        }

        _arts.Add(art);
        return art;
    }

    /// <summary>The card's heading: the kind where this server has a word for it, and the event's name (or EZPug) where it does not.</summary>
    private string Heading(string kind, Locale locale) =>
        Kinds.Contains(kind)
            ? _localizer().For(locale)[$"hud.moment.{kind}"]
            : Branding.EventNameOf(_assignment?.Branding) ?? Branding.PlatformName;

    private void Hide(ulong steamId64)
    {
        if (_world.Find(steamId64) is { IsBot: false } person)
        {
            _hud.SetClass(person, Layout, Card, Shown, false);
            _hud.SetClass(person, Layout, Card, Turned, false);
        }
    }

    /// <summary>
    /// Somebody is playing: every card on a screen goes, at once. One that had not
    /// turned over showed its back and nothing else, so it goes back to the front of its
    /// person's queue and its cap keeps counting from when it was due.
    /// </summary>
    private void PutAway()
    {
        foreach (var (steamId64, seat) in _seats)
        {
            if (seat.Showing is not { } card)
            {
                continue;
            }

            seat.Timer?.Cancel();
            seat.Timer = null;
            seat.Showing = null;
            Hide(steamId64);
            if (!seat.Turned)
            {
                seat.Queue.AddFirst(card);
            }
        }
    }

    // ------------------------------------------------------------------ the runtime's hooks

    internal void OnAssigned(Assignment assignment)
    {
        Stop();
        _assignment = assignment;
    }

    /// <summary>The match is over: no moment is still coming, no card is waiting. The HUD takes the layouts and everything on them.</summary>
    internal void OnReleased() => Stop();

    /// <summary>Every timer cancelled and everything forgotten, from wherever it stands: the release, a reassignment, the plugin unloading.</summary>
    public void Stop()
    {
        foreach (var timer in _due)
        {
            timer.Cancel();
        }

        _due.Clear();
        foreach (var seat in _seats.Values)
        {
            seat.Timer?.Cancel();
        }

        _seats.Clear();
        foreach (var row in _rows)
        {
            row.Timer?.Cancel();
            row.Timer = null;
            row.Taken = false;
        }

        _toasts.Clear();
        _arts.Clear();
        _assignment = null;
    }

    /// <summary>A map change: a card is about a moment in the map that was being played, so the ones still waiting are dropped and one on a screen is put away. A moment that is not due yet is still told.</summary>
    internal void OnMapStarted()
    {
        foreach (var (steamId64, seat) in _seats)
        {
            seat.Timer?.Cancel();
            seat.Timer = null;
            seat.Resting = false;
            seat.Queue.Clear();
            if (seat.Showing is not null)
            {
                seat.Showing = null;
                Hide(steamId64);
            }
        }
    }

    /// <summary>A round started: a freeze to show a waiting card in, or, in a mode without one, somebody playing.</summary>
    internal void OnRoundStarted() => StretchOrNot();

    /// <summary>The freeze ended: if that means somebody is playing, no card stays on a screen.</summary>
    internal void OnFreezeEnded() => StretchOrNot();

    /// <summary>The round is decided: the restart delay and the freeze behind it are the longest stretch a live match has.</summary>
    internal void OnRoundEnded() => StretchOrNot();

    /// <summary>The map is over and the scoreboard is up.</summary>
    internal void OnMapEnded() => StretchOrNot();

    private void StretchOrNot()
    {
        if (!_hud.On)
        {
            return;
        }

        if (_hud.Quiet is null)
        {
            PutAway();
        }
        else
        {
            NextForEverybody();
        }
    }

    /// <summary>They left: nothing waits for them, and what was on their screen leaves with the HUD's record of it.</summary>
    internal void OnPlayerDisconnected(IGamePlayer player)
    {
        if (_seats.Remove(player.SteamId64, out var seat))
        {
            seat.Timer?.Cancel();
        }
    }
}
