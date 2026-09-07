using EZPug.Sdk.Protocol;

namespace EZPug.Sdk;

/// <summary>
/// <b>EZ Rating where Premier shows its number</b> (decision 21, PRD-02 T27), and the one
/// line that greets a player with it.
///
/// The rating is the roster's, never this server's: it arrives in the assignment's
/// profiles or in a <c>profile</c> push, and all this does is draw it. Both halves hang
/// off the manifest's <c>scoreboardRating</c> capability — a mode that did not ask for it
/// gets neither the number nor the line, and a player nobody has a profile for is left
/// alone rather than shown a zero.
///
/// The engine forgets what was written across a level change and a player who reconnects,
/// so the number is written again at every point where what is standing there can have
/// changed: the assignment, a connect, a profile, the map, a round start — which the
/// engine raises <i>after</i> the round's spawns, so it is the redraw a spawn needs too.
/// The greeting is not: it is once per connection, at the first moment there is something to say —
/// on connect for a rostered player, on their <c>profile</c> for somebody who joined open
/// (retakes, a deathmatch) and was a stranger until it arrived.
/// </summary>
public sealed class RatingBoard
{
    private readonly IGameWorld _world;
    private readonly Func<Localizer> _localizer;
    private readonly HashSet<ulong> _greeted = [];
    private Assignment? _assignment;

    public RatingBoard(IGameWorld world, Func<Localizer> localizer)
    {
        _world = world;
        _localizer = localizer;
    }

    /// <summary>Whether this match asked for a rating on its scoreboard.</summary>
    public bool Active => _assignment is not null;

    /// <summary>A match is assigned: draw for everybody already standing, and greet nobody — they were greeted, or will be when a profile for them arrives.</summary>
    public void OnAssigned(Assignment assignment)
    {
        _greeted.Clear();
        _assignment = assignment.Gamemode.Capabilities.ScoreboardRating ? assignment : null;
        DrawAll();
    }

    /// <summary>The match is over: the scoreboard goes back to showing nothing, so the next one starts clean even for a player who stayed connected.</summary>
    public void OnReleased()
    {
        if (_assignment is not null)
        {
            foreach (var player in _world.Players)
            {
                _world.SetScoreboardRating(player, null);
            }
        }

        _assignment = null;
        _greeted.Clear();
    }

    public void OnPlayerConnected(IGamePlayer player) => Draw(player, greet: true);

    public void OnPlayerDisconnected(IGamePlayer player) => _greeted.Remove(player.SteamId64);

    /// <summary>A profile arrived or was refreshed: the number follows it, and a player nobody knew until now is greeted with it.</summary>
    public void OnProfile(ulong steamId64)
    {
        if (_world.Find(steamId64) is { } player)
        {
            Draw(player, greet: true);
        }
    }

    /// <summary>The map is up and configured, or a round started: write the numbers again for everybody, because the engine kept none of them.</summary>
    public void DrawAll()
    {
        foreach (var player in _world.Players)
        {
            Draw(player, greet: false);
        }
    }

    private void Draw(IGamePlayer player, bool greet)
    {
        if (_assignment is not { } assignment || assignment.ProfileOf(player.SteamId64) is not { } profile)
        {
            return;
        }

        if (profile.Rating is { } rating)
        {
            _world.SetScoreboardRating(player, (int)Math.Clamp(rating, 0, int.MaxValue));
        }

        if (greet && _greeted.Add(player.SteamId64) && !player.IsBot)
        {
            _world.Say(player, Greeting(profile));
        }
    }

    /// <summary>The connect line in the player's own language: their name, their rating, their rank when the profile names one.</summary>
    internal string Greeting(RosterEntry profile)
    {
        var lines = _localizer().For(profile.Locale);
        if (profile.Rating is not { } rating)
        {
            return lines["rating.connect.unrated", profile.Name];
        }

        return profile.RankName is { Length: > 0 } rank
            ? lines["rating.connect.rank", profile.Name, rating, rank]
            : lines["rating.connect", profile.Name, rating];
    }
}
