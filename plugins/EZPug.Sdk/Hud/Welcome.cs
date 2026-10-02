using EZPug.Sdk.Protocol;
using System.Text.RegularExpressions;

namespace EZPug.Sdk;

/// <summary>
/// <b>The welcome</b> (PRD-07 T5): the connect card, drawn by the HUD for somebody who
/// joins while nobody is playing. A card slides in at the right edge: the banner, the
/// event's name or EZPug, its tagline or the house one, the team they play for, the one
/// thing to do and <c>ezpug.com</c>, in their own language. It stays
/// <see cref="CardMs"/>, shrinks into a small mark for the rest of warmup, and is gone
/// when the match goes live. The layout is <c>hud/layout/ezpug_welcome.xml</c>; this
/// class names its panels and classes and nothing else does.
///
/// <para><b>One card, never two.</b> <see cref="Branding"/> asks <see cref="Show"/> at
/// the moment it would print the centre card, and prints it only when the answer is no:
/// the HUD is off, the player was already on the server when the match was assigned (they
/// connected before the addon was handed out, so they cannot have it), or somebody is
/// playing, or the freeze left is shorter than the card. So with the HUD off the centre
/// card is what it always was.</para>
///
/// <para><b>Decoration.</b> Everything here goes through <see cref="Hud"/>, which keeps
/// the lifetime rules and is inert when the HUD is off. The welcome never waits for a
/// client and reads nothing back. What it says is also said in chat (the team line, the
/// rating greeting, the warmup lines, the prefix with the event's name).</para>
///
/// <para>When it goes away:</para>
/// <list type="bullet">
/// <item><see cref="CardMs"/> after it came, into the mark while the match is in warmup
/// (or no round has started yet), and off the edge otherwise.</item>
/// <item>At a round start that is not warmup, the marks go: the match is live. A card
/// still up may finish in the freeze time.</item>
/// <item>The instant somebody is playing (the freeze ends, or a round starts without
/// one), everything goes at once.</item>
/// </list>
/// </summary>
public sealed partial class Welcome
{
    /// <summary>The layout, by its source path in the addon.</summary>
    public const string Layout = "panorama/layout/custom_game/ezpug_welcome.xml";

    /// <summary>How long the full card stays, and so the stretch of nobody playing it needs.</summary>
    public const long CardMs = 8_000;

    /// <summary>The panel that carries the banner's class for everybody.</summary>
    public const string Root = "welcome";

    public const string Card = "welcome_card";
    public const string Mark = "welcome_mark";

    /// <summary>On the card and on the mark: on screen.</summary>
    public const string Shown = "shown";

    /// <summary>On the card: shrunk into the mark's corner, invisible.</summary>
    public const string Shrunk = "shrunk";

    /// <summary>On the card: no team line (a free-for-all, somebody who joined open).</summary>
    public const string Teamless = "teamless";

    /// <summary>The banner a request names becomes <c>banner-&lt;key&gt;</c> on <see cref="Root"/>; no class is the house banner.</summary>
    public const string BannerClassPrefix = "banner-";

    /// <summary>The house banner's key: never a class, it is what no class shows.</summary>
    public const string DefaultBanner = "default";

    /// <summary>Every label binds <c>{s:text}</c>, set on the label's own id.</summary>
    public const string Text = "text";

    public const string Eyebrow = "welcome_eyebrow";
    public const string Title = "welcome_title";
    public const string Tagline = "welcome_tagline";
    public const string Team = "welcome_team";
    public const string ToDo = "welcome_todo";
    public const string Url = "welcome_url";
    public const string MarkTitle = "welcome_mark_title";
    public const string MarkUrl = "welcome_mark_url";

    /// <summary>The contract's grammar for a picture key (<c>hudKeySchema</c>): a key outside it names no class.</summary>
    [GeneratedRegex("^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$")]
    private static partial Regex Key();

    private readonly IGameWorld _world;
    private readonly Hud _hud;
    private readonly Func<Localizer> _localizer;
    private readonly Dictionary<ulong, IClockTimer> _cards = [];
    /// <summary>Everybody the welcome was shown to in this match, card or mark: who "put everything away" reaches.</summary>
    private readonly HashSet<ulong> _welcomed = [];
    private Assignment? _assignment;

    public Welcome(IGameWorld world, Hud hud, Func<Localizer> localizer)
    {
        _world = world;
        _hud = hud;
        _localizer = localizer;
        hud.Register(Layout);
    }

    /// <summary>The class the request's banner puts on <see cref="Root"/>, or <c>null</c> for the house banner. A key the addon does not hold is a class no rule draws, which is the house banner too.</summary>
    public static string? BannerClassOf(MatchBranding? branding) =>
        branding?.Banner is { } key && key != DefaultBanner && key.Length <= 64 && Key().IsMatch(key)
            ? BannerClassPrefix + key
            : null;

    /// <summary>The request's tagline, cleaned like the event's name; <c>null</c> when it named none, and the house line is shown.</summary>
    public static string? TaglineOf(MatchBranding? branding) =>
        branding?.Tagline is { Length: > 0 } tagline && ChatColor.Strip(tagline).Trim() is { Length: > 0 } clean
            ? clean
            : null;

    /// <summary>
    /// Show the welcome to somebody who just arrived, if it can be shown now: the HUD is on
    /// for this match and nobody will be playing before the card is done. <c>false</c>
    /// means nothing was drawn and the caller prints the centre card.
    /// </summary>
    public bool Show(IGamePlayer player)
    {
        if (player.IsBot || _assignment is not { } assignment || !_hud.On || _hud.Quiet is not { } quiet || !quiet.Fits(CardMs))
        {
            return false;
        }

        var steamId64 = player.SteamId64;
        var lines = _localizer().For(assignment.LocaleOf(steamId64));
        _hud.SetVariable(player, Layout, Eyebrow, Text, lines["hud.welcome.eyebrow"]);
        _hud.SetVariable(player, Layout, Tagline, Text, TaglineOf(assignment.Branding) ?? lines["hud.welcome.tagline"]);
        // The same rule as the chat line: a free-for-all has a roster with a `teamA` in it,
        // and nobody in a deathmatch plays for Team A.
        var team = assignment.Gamemode.Slots.Teams > 1 && assignment.RosteredTeamOf(steamId64) is { } rostered
            ? ChatColor.Strip((rostered == MatchTeam.TeamA ? assignment.Teams.TeamA : assignment.Teams.TeamB).Name)
            : null;
        _hud.SetVariable(player, Layout, Team, Text, team is null ? "" : lines["branding.team", team]);
        _hud.SetClass(player, Layout, Card, Teamless, team is null);
        _hud.SetVariable(player, Layout, ToDo, Text, Branding.WhatToDo(assignment, lines));
        _hud.SetClass(player, Layout, Card, Shrunk, false);
        _hud.SetClass(player, Layout, Mark, Shown, false);
        _hud.SetClass(player, Layout, Card, Shown, true);
        _welcomed.Add(steamId64);

        Cancel(steamId64);
        _cards[steamId64] = _world.Clock.After(CardMs, () =>
        {
            _cards.Remove(steamId64);
            if (_world.Find(steamId64) is not { } still)
            {
                return;
            }

            var stays = _hud.Quiet?.Reason is QuietReason.Warmup or QuietReason.NoRound;
            _hud.SetClass(still, Layout, Card, Shown, false);
            _hud.SetClass(still, Layout, Card, Shrunk, stays);
            _hud.SetClass(still, Layout, Mark, Shown, stays);
        });
        return true;
    }

    // ------------------------------------------------------------------ the runtime's hooks

    /// <summary>A match is assigned: what the welcome says to everybody (the event's name, the banner), on the HUD's word that it is on.</summary>
    internal void OnAssigned(Assignment assignment)
    {
        CancelAll();
        _welcomed.Clear();
        _assignment = assignment;
        if (!_hud.On)
        {
            return;
        }

        var title = Branding.EventNameOf(assignment.Branding) ?? Branding.PlatformName;
        _hud.SetVariable(Layout, Title, Text, title);
        _hud.SetVariable(Layout, MarkTitle, Text, title);
        _hud.SetVariable(Layout, Url, Text, Branding.PlatformUrl);
        _hud.SetVariable(Layout, MarkUrl, Text, Branding.PlatformUrl);
        if (BannerClassOf(assignment.Branding) is { } banner)
        {
            _hud.SetClass(Layout, Root, banner, true);
        }
    }

    /// <summary>The match is over. The HUD takes the layouts and everything on them; no card is still coming.</summary>
    internal void OnReleased()
    {
        CancelAll();
        _welcomed.Clear();
        _assignment = null;
    }

    /// <summary>A round started: past warmup the match is live and the marks go; with no freeze to stand in, everything goes.</summary>
    internal void OnRoundStarted()
    {
        switch (_hud.Quiet)
        {
            case null:
                PutAway(cards: true);
                break;
            case { Reason: not QuietReason.Warmup }:
                PutAway(cards: false);
                break;
        }
    }

    /// <summary>The freeze ended: if that means somebody is playing, nothing of the welcome stays on a screen.</summary>
    internal void OnFreezeEnded()
    {
        if (_hud.On && _hud.Quiet is null)
        {
            PutAway(cards: true);
        }
    }

    /// <summary>They left: their card is not finished for whoever takes the slot. The HUD forgets what they were shown.</summary>
    internal void OnPlayerDisconnected(IGamePlayer player)
    {
        Cancel(player.SteamId64);
        _welcomed.Remove(player.SteamId64);
    }

    /// <summary>The marks off every screen, and with <paramref name="cards"/> the cards that are still up as well.</summary>
    private void PutAway(bool cards)
    {
        foreach (var steamId64 in _welcomed.ToList())
        {
            var showing = _cards.ContainsKey(steamId64);
            if (showing && !cards)
            {
                continue;
            }

            Cancel(steamId64);
            _welcomed.Remove(steamId64);
            if (_world.Find(steamId64) is { } player)
            {
                _hud.SetClass(player, Layout, Card, Shown, false);
                _hud.SetClass(player, Layout, Card, Shrunk, false);
                _hud.SetClass(player, Layout, Mark, Shown, false);
            }
        }
    }

    private void Cancel(ulong steamId64)
    {
        if (_cards.Remove(steamId64, out var timer))
        {
            timer.Cancel();
        }
    }

    private void CancelAll()
    {
        foreach (var timer in _cards.Values)
        {
            timer.Cancel();
        }

        _cards.Clear();
    }
}
