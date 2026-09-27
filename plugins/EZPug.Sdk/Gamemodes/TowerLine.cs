using EZPug.Sdk.Protocol;

namespace EZPug.Sdk;

/// <summary>
/// <b>A tower map's line, walked from the round winners the engine reports</b> (PRD-06 T3).
/// Rush is not the engine's game and not a plugin's: <c>maps/scripts/rush_001.vjs</c>
/// decides every round with <c>FireWinCondition</c>, moves the spawns and the tower one
/// room along a line of seven, and ends the match in a castle. This class never reads
/// that script's state. It follows the same rules from what the engine already says —
/// who won each round, and who was still standing when it ended — so the round's room,
/// who held its tower and how it was won are facts the SDK can name on its own. The
/// simulator walks the same line by the same rules (<c>packages/sim/src/tower.ts</c>).
///
/// <list type="bullet">
/// <item><b>The line.</b> Seven rooms, index 0 the T castle (<c>401</c>), 3 the start
/// room, 6 the CT castle (<c>301</c>). The T side holds 0–2 and CT holds 3–6 as the map
/// goes live, and a room keeps whoever won the last round played in it
/// (<c>SetRoomControl</c>); a drawn round leaves it nobody's.</item>
/// <item><b>The walk.</b> A T win moves play one room up, a CT win one room down, a draw
/// replays the room; a win that would walk out past a castle ends the map there.</item>
/// <item><b>Convoy.</b> A round end at 7–7 swaps the next room for the decider.</item>
/// </list>
///
/// <b>Which arena a room is</b> is the script's own random draw, and nothing the engine
/// says carries it, so a mid or start room goes without a <c>roomId</c>. The castles
/// and Convoy are the rules' and are named.
/// </summary>
public sealed class TowerLine
{
    /// <summary>
    /// <b>The maps whose rounds are a tower script's, and the engine game each loads
    /// under</b>: <c>rush_001</c> is <c>game_type 0</c> / <c>game_mode 6</c>, its own entry in
    /// the node's <c>gamemodes.txt</c>. Keyed on the map, as the simulator's
    /// <c>TOWER_MAPS</c> is: the rules live on it, whichever manifest asked for it.
    /// </summary>
    public static readonly IReadOnlyDictionary<string, EngineGame> Maps = new Dictionary<string, EngineGame>(StringComparer.Ordinal)
    {
        ["rush_001"] = new EngineGame { GameType = 0, GameMode = 6 },
    };

    public const int RoomCount = 7;
    public const int StartIndex = 3;
    public const int RoundsToWin = 8;
    private const int TCastleIndex = 0;
    private const int CtCastleIndex = RoomCount - 1;

    private readonly TeamSide?[] _held = [TeamSide.T, TeamSide.T, TeamSide.T, TeamSide.Ct, TeamSide.Ct, TeamSide.Ct, TeamSide.Ct];
    private readonly bool[] _convoy = new bool[RoomCount];
    private int _index = StartIndex;
    private int _tWins;
    private int _ctWins;

    public static bool IsTowerMap(string? map) => map is not null && Maps.ContainsKey(map);

    /// <summary>Who holds the tower of the room the next round is played in; <c>null</c> after a draw left it nobody's.</summary>
    public TeamSide? HeldBy => _held[_index];

    /// <summary>Where the last round was played, once one has been; <c>null</c> before.</summary>
    public int? LastIndex { get; private set; }

    /// <summary><c>castle</c> once a win walked out past one; <c>null</c> while the line goes on.</summary>
    public TowerMapEnding? Ending { get; private set; }

    /// <summary>
    /// One round is over: the tower it was played for, how it was won, and the line moved
    /// on by the script's rule. <paramref name="winner"/> is <c>null</c> for a draw, which
    /// leaves the room nobody's and is replayed; the tower is still returned, for a log
    /// line, and a draw has no condition.
    /// </summary>
    /// <param name="attackersStanding">
    /// Whether anybody on the side that did not hold the tower was still alive as the
    /// round ended. The engine's own reason cannot say it: the script ends a held round on
    /// the clock through <c>mp_default_team_winner_no_objective</c> and an eliminated one
    /// through <c>FireWinCondition</c>, and both reach the engine as a team win. Measured
    /// on the dev node (PRD-06 T3): all fifteen round ends of a Rush map came as
    /// <c>CTsWin</c>/<c>TerroristsWin</c>, the sixty seconds of Convoy won on the clock among them.
    /// </param>
    public (RoundTower Tower, RoundWinCondition? Condition) Play(TeamSide? winner, bool attackersStanding)
    {
        var heldBy = _held[_index];
        var tower = new RoundTower { Room = _index + 1, RoomId = RoomIdAt(_index), HeldBy = heldBy };
        LastIndex = _index;
        _held[_index] = winner;
        if (winner is not { } side)
        {
            return (tower, null);
        }

        var condition = side != heldBy ? RoundWinCondition.TowerCaptured
            : attackersStanding ? RoundWinCondition.TowerHeld
            : RoundWinCondition.Elimination;
        if (side == TeamSide.T)
        {
            _tWins++;
        }
        else
        {
            _ctWins++;
        }

        var next = _index + (side == TeamSide.T ? 1 : -1);
        if (next is < TCastleIndex or > CtCastleIndex)
        {
            Ending = TowerMapEnding.Castle;
            return (tower, condition);
        }

        if (_tWins == RoundsToWin - 1 && _ctWins == RoundsToWin - 1)
        {
            _convoy[next] = true;
        }

        _index = next;
        return (tower, condition);
    }

    /// <summary>Where the line stood as the map ended, or <c>null</c> when no round was played on it.</summary>
    public MapTower? End() =>
        LastIndex is { } last
            ? new MapTower { Room = last + 1, RoomId = RoomIdAt(last), Ending = Ending ?? TowerMapEnding.Rounds }
            : null;

    private RushRoomId? RoomIdAt(int index) =>
        _convoy[index] ? RushRoomId.Convoy
        : index == TCastleIndex ? RushRoomId._401
        : index == CtCastleIndex ? RushRoomId._301
        : null;
}
