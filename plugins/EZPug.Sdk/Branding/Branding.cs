using EZPug.Sdk.Protocol;

namespace EZPug.Sdk;

/// <summary>
/// <b>What the server looks like to the people on it</b> (decision 22, PRD-02 T29):
/// the hostname in the browser, the coloured prefix in front of every line the server
/// says, the two team names in the colours of the sides they are playing, and the card
/// a player reads in the middle of the screen when they arrive. All of it from the
/// assignment — the request's <c>branding</c> and the manifest — so a match branded for
/// an event is branded everywhere at once and nothing here is a per-server setting.
///
/// This round's branding is chat and the hostname; in-world banners need a Workshop
/// addon players download and are a later round (decision 22).
///
/// <list type="bullet">
/// <item><b>The hostname</b> is <c>branding.hostname</c> when the request named one, and
/// otherwise ours: <c>EZPug · pug · Mirage</c>, with the event between the two when the
/// request named one. The loader sets it on <c>assign</c> and writes the same string into
/// MatchZy's <c>matchzy_hostname_format</c>, which is what MatchZy rewrites the hostname
/// from every round.</item>
/// <item><b>The prefix</b> is the event's name, or <c>EZPug</c>, in green between
/// brackets. Every line the SDK says to a player carries it — the rating greeting, a
/// refused player command, a mode's own lines through <see cref="Gamemode.Say"/> — so the
/// server has one voice. A client's <c>announce</c> does not: those are the client's
/// words, relayed, and the platform brands them itself.</item>
/// <item><b>A team name</b> is painted in the colour of the side it is on right now
/// (<see cref="MatchContext.TeamASide"/>, which a <c>side_swap</c> moves), so the names
/// in chat and the players on the scoreboard agree after halftime.</item>
/// <item><b>The card</b> is four lines in the middle of the screen, in the player's own
/// language: the event or EZPug, what this gamemode is, what to do now, and where the
/// platform lives. HTML, because that is what the engine's centre panel reads, and
/// <see cref="CardDelayMs"/> after the connect, because the connect is
/// <c>player_connect_full</c> and a card in the same instant is a card behind the
/// client's own loading chatter.</item>
/// </list>
/// </summary>
public sealed class Branding
{
    /// <summary>What the server calls itself when no event is named.</summary>
    public const string PlatformName = "EZPug";

    /// <summary>Where a player goes to find their match — the last line of the card.</summary>
    public const string PlatformUrl = "ezpug.com";

    /// <summary>The separator between the parts of a hostname we build ourselves.</summary>
    public const string HostnameSeparator = " · ";

    /// <summary>How long a hostname we build may be. The Match API caps the request's at the same length.</summary>
    public const int HostnameMax = 63;

    /// <summary>How much of an event's name fits in a chat prefix before it stops being a prefix.</summary>
    public const int PrefixNameMax = 24;

    /// <summary>How long after a player is fully connected the card is drawn.</summary>
    public const long CardDelayMs = 2_000;

    private readonly IGameWorld _world;
    private readonly Func<Localizer> _localizer;
    private readonly MatchContext _match;
    private readonly Dictionary<ulong, IClockTimer> _cards = [];
    private Assignment? _assignment;

    public Branding(IGameWorld world, Func<Localizer> localizer, MatchContext match)
    {
        _world = world;
        _localizer = localizer;
        _match = match;
    }

    /// <summary>The match being branded, or <c>null</c> between matches (when the prefix is still EZPug's own).</summary>
    public Assignment? Assignment => _assignment;

    // ------------------------------------------------------------------ the hostname

    /// <summary>
    /// The hostname for this match on this map: the request's when it named one, and
    /// otherwise <c>EZPug · &lt;event&gt; · &lt;mode&gt; · &lt;Map&gt;</c> with the event
    /// left out when there is none. Clamped to <see cref="HostnameMax"/>, because a
    /// hostname the browser truncates says less than a shorter one.
    /// </summary>
    public static string HostnameFor(Assignment assignment, string map) =>
        HostnameFor(assignment.Branding, assignment.Gamemode.Id, map);

    /// <inheritdoc cref="HostnameFor(Assignment, string)"/>
    public static string HostnameFor(MatchBranding? branding, string gamemodeId, string map)
    {
        if (branding?.Hostname is { Length: > 0 } asked)
        {
            return Clamp(ChatColor.Strip(asked.Trim()));
        }

        var parts = new List<string> { PlatformName };
        if (EventNameOf(branding) is { } eventName)
        {
            parts.Add(eventName);
        }

        parts.Add(gamemodeId);
        parts.Add(PrettyMap(map));
        return Clamp(string.Join(HostnameSeparator, parts));
    }

    /// <summary><c>de_mirage</c> → <c>Mirage</c>; a workshop id stays as it is.</summary>
    public static string PrettyMap(string map)
    {
        var name = map.Contains('_') ? map[(map.IndexOf('_') + 1)..] : map;
        return name.Length == 0 ? map : char.ToUpperInvariant(name[0]) + name[1..];
    }

    private static string Clamp(string hostname) =>
        hostname.Length <= HostnameMax ? hostname : hostname[..(HostnameMax - 1)].TrimEnd() + "…";

    // ------------------------------------------------------------------ the chat voice

    /// <summary>The event's name where the request gave one, cleaned of anything that would colour a line; <c>null</c> otherwise.</summary>
    public static string? EventNameOf(MatchBranding? branding) =>
        branding?.EventName is { Length: > 0 } name && ChatColor.Strip(name).Trim() is { Length: > 0 } clean
            ? clean
            : null;

    /// <summary>The bracketed green prefix for a match branded like this: the event's name, or <c>EZPug</c>.</summary>
    public static string PrefixFor(MatchBranding? branding)
    {
        var name = EventNameOf(branding) is { } eventName
            ? eventName.Length > PrefixNameMax ? eventName[..PrefixNameMax].TrimEnd() : eventName
            : PlatformName;
        return $"[{ChatColor.Paint(ChatColor.Green, name)}]";
    }

    /// <summary><paramref name="text"/> behind the prefix — the shape of every line the server says.</summary>
    public static string Prefixed(string text, MatchBranding? branding = null) => $"{PrefixFor(branding)} {text}";

    /// <summary>This match's prefix; EZPug's own between matches.</summary>
    public string Prefix => PrefixFor(_assignment?.Branding);

    /// <summary><paramref name="text"/> behind this match's prefix.</summary>
    public string Line(string text) => $"{Prefix} {text}";

    /// <summary>Say a line to everybody, branded.</summary>
    public void Say(string text) => _world.Say(Line(text));

    /// <summary>Say a line to one player, branded.</summary>
    public void Say(IGamePlayer player, string text) => _world.Say(player, Line(text));

    /// <summary>
    /// A team's name in the colour of the side it is playing right now — CT blue, T gold,
    /// the same two colours the engine paints those sides. The side comes from the map
    /// plan and moves with every <c>side_swap</c>, so the names in chat and the players on
    /// the scoreboard still agree after halftime; a knife round that has not been played
    /// yet is drawn on the plan's own default until it decides.
    /// </summary>
    public string TeamName(MatchTeam team)
    {
        var roster = team == MatchTeam.TeamA ? _assignment?.Teams.TeamA : _assignment?.Teams.TeamB;
        var name = ChatColor.Strip(roster?.Name ?? (team == MatchTeam.TeamA ? "Team A" : "Team B"));
        var side = team == MatchTeam.TeamA
            ? _match.TeamASide
            : _match.TeamASide == TeamSide.Ct ? TeamSide.T : TeamSide.Ct;
        return ChatColor.Paint(side == TeamSide.Ct ? ChatColor.Blue : ChatColor.Gold, name);
    }

    /// <summary>The name of the team this player is rostered on, coloured; <c>null</c> for somebody who joined open.</summary>
    public string? TeamNameOf(IGamePlayer player) =>
        _assignment?.RosteredTeamOf(player.SteamId64) is { } team ? TeamName(team) : null;

    // ------------------------------------------------------------------ the card

    /// <summary>
    /// The card's lines in <paramref name="locale"/>, plain: the event or EZPug, this
    /// gamemode's own title from its manifest, what to do now, and the platform. Plain
    /// text so a test reads what a player reads; <see cref="CardHtml"/> is what is printed.
    /// </summary>
    public IReadOnlyList<string> CardLines(Locale locale)
    {
        if (_assignment is not { } assignment)
        {
            return [];
        }

        var lines = _localizer().For(locale);
        return
        [
            EventNameOf(assignment.Branding) ?? PlatformName,
            assignment.Gamemode.Title.In(locale),
            WhatToDo(assignment, lines),
            PlatformUrl,
        ];
    }

    /// <summary>The card as the engine's centre panel reads it: the same lines, coloured, one per row.</summary>
    public string CardHtml(Locale locale)
    {
        var lines = CardLines(locale);
        if (lines.Count == 0)
        {
            return "";
        }

        return string.Join("<br>",
        [
            $"<font class='fontSize-l' color='{CardAccent}'>{Escape(lines[0])}</font>",
            $"<font class='fontSize-m' color='{CardText}'>{Escape(lines[1])}</font>",
            $"<font class='fontSize-sm' color='{CardMuted}'>{Escape(lines[2])}</font>",
            $"<font class='fontSize-sm' color='{CardAccent}'>{Escape(lines[3])}</font>",
        ]);
    }

    /// <summary>EZPug's green, as the centre panel spells a colour.</summary>
    public const string CardAccent = "#57d364";
    private const string CardText = "#ffffff";
    private const string CardMuted = "#c8c8c8";

    /// <summary>
    /// The one instruction that is worth a line: ready up when MatchZy is running the
    /// match, the phone when the mode has verbs to tap, and otherwise nothing to do but
    /// play.
    /// </summary>
    private static string WhatToDo(Assignment assignment, LocalizedLines lines) =>
        assignment.Gamemode.Flow == GamemodeFlow.Matchzy ? lines["branding.card.ready"]
        : assignment.Gamemode.Capabilities.PlayerCommands || assignment.Gamemode.Capabilities.Widget ? lines["branding.card.widget", PlatformUrl]
        : lines["branding.card.enjoy"];

    /// <summary>Anything from outside that lands in the panel's markup: an event's name, a manifest's title.</summary>
    private static string Escape(string text) =>
        text.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;");

    // ------------------------------------------------------------------ the runtime's hooks

    /// <summary>A match is assigned: everybody already standing here is told what they walked into.</summary>
    public void OnAssigned(Assignment assignment)
    {
        CancelCards();
        _assignment = assignment;
        foreach (var player in _world.Players)
        {
            Welcome(player);
        }
    }

    /// <summary>The match is over: no card is still coming, and the voice goes back to EZPug's own.</summary>
    public void OnReleased()
    {
        CancelCards();
        _assignment = null;
    }

    /// <summary>A player arrived: their team, and their card a beat later.</summary>
    public void OnPlayerConnected(IGamePlayer player)
    {
        if (_assignment is not null)
        {
            Welcome(player);
        }
    }

    /// <summary>A player left before their card was drawn: it is not drawn.</summary>
    public void OnPlayerDisconnected(IGamePlayer player) => Cancel(player.SteamId64);

    private void Welcome(IGamePlayer player)
    {
        if (player.IsBot || _assignment is not { } assignment)
        {
            return;
        }

        var locale = assignment.LocaleOf(player.SteamId64);
        // A free-for-all has a roster with a `teamA` in it because the request always
        // does; it has no team to play for, and telling somebody they play for Team A in
        // a deathmatch is a lie the branding is not going to tell.
        if (assignment.Gamemode.Slots.Teams > 1 && TeamNameOf(player) is { } team)
        {
            Say(player, _localizer().For(locale)["branding.team", team]);
        }

        Cancel(player.SteamId64);
        var steamId64 = player.SteamId64;
        _cards[steamId64] = _world.Clock.After(CardDelayMs, () =>
        {
            _cards.Remove(steamId64);
            if (_assignment is null || _world.Find(steamId64) is not { } still)
            {
                return;
            }

            _world.PrintHud(still, CardHtml(locale));
        });
    }

    private void Cancel(ulong steamId64)
    {
        if (_cards.Remove(steamId64, out var timer))
        {
            timer.Cancel();
        }
    }

    private void CancelCards()
    {
        foreach (var timer in _cards.Values)
        {
            timer.Cancel();
        }

        _cards.Clear();
    }
}
