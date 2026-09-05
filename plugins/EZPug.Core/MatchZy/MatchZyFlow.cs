using EZPug.Sdk;
using EZPug.Sdk.Protocol;

namespace EZPug.Core;

/// <summary>
/// <b>What MatchZy cannot say, observed</b> (decision 19, PRD-02 T9). For a <c>matchzy</c>
/// flow MatchZy owns the match-flow facts and speaks them to the orchestrator over its
/// remote log (<see cref="MatchZyRemoteLog"/>); the four things it never sends — a pause,
/// the sides after a swap, a round backup landing on disk, the map number of a series —
/// are engine facts this class reads off the world and emits through the runtime, once,
/// so nobody double-speaks MatchZy's own events:
///
/// <list type="bullet">
/// <item><c>match_paused</c> / <c>match_unpaused</c> from the gamerules, polled every
/// <see cref="PollIntervalMs"/>: a tactical timeout names its team, a technical one its
/// kind, a <c>pause</c> command relayed over the link is answered with MatchZy's own
/// <c>css_forcepause</c> and reported as an admin pause. A pause is reported when it is
/// <i>requested</i> (<c>mp_pause_match</c> takes effect at the next freeze time), which is
/// when MatchZy itself says "paused" in chat.</item>
/// <item><c>side_swap</c> at a round start, when the rostered team A stands on another
/// side than the context holds — a knife winner's <c>.switch</c> and halftime alike — or,
/// with nobody rostered (bots), when the engine said it swaps at the round reset.</item>
/// <item>a <c>backup</c> frame and <c>backup_written</c> a moment after a live round starts,
/// from the newest file MatchZy wrote for this match and map, scrubbed of the token
/// (<see cref="MatchZyBackups"/>).</item>
/// </list>
///
/// Pure over <see cref="IGameWorld"/> and the runtime, proven on the harness; inactive for
/// any other flow.
/// </summary>
public sealed class MatchZyFlow
{
    /// <summary>How often the gamerules are read for a pause or a pending swap.</summary>
    public const long PollIntervalMs = 250;

    /// <summary>How long after a round start MatchZy's backup file is looked for — it writes on the same event, in whichever order the plugins run.</summary>
    public const long BackupSettleMs = 1_500;

    private readonly IGameWorld _world;
    private readonly GamemodeRuntime _runtime;
    private readonly string _csgoDirectory;
    private readonly ILinkLog _log;
    private bool _active;
    private long _serial;
    private IClockTimer? _poll;
    private IClockTimer? _backupScan;
    private bool _standing;
    private bool _adminPause;
    private bool _pendingSwap;
    private string? _lastBackup;

    public MatchZyFlow(IGameWorld world, GamemodeRuntime runtime, string csgoDirectory, ILinkLog? log = null)
    {
        _world = world;
        _runtime = runtime;
        _csgoDirectory = csgoDirectory;
        _log = log ?? NullLinkLog.Instance;
    }

    /// <summary>Whether a matchzy-flow match is assigned right now.</summary>
    public bool Active => _active;

    /// <summary>The <c>matchid</c> MatchZy knows the current match by, from the assignment's config; <c>0</c> when none.</summary>
    public long Serial => _serial;

    /// <summary>Hook the runtime's host events and the world's, and take the runtime's command hook.</summary>
    public void Bind()
    {
        _runtime.Assigned += OnAssigned;
        _runtime.Released += OnReleased;
        _runtime.CommandHook = OnCommand;
        _world.RoundStarted += OnRoundStarted;
    }

    private void OnAssigned(Assignment assignment)
    {
        Disarm();
        _active = assignment.Gamemode.Flow == GamemodeFlow.Matchzy;
        _serial = 0;
        _standing = false;
        _adminPause = false;
        _pendingSwap = false;
        _lastBackup = null;
        if (!_active)
        {
            return;
        }

        if (assignment.MatchzyConfig?["matchid"] is { } matchid && long.TryParse(matchid.ToString(), out var serial))
        {
            _serial = serial;
        }
        else
        {
            _log.Warn("a matchzy flow whose config has no numeric matchid: MatchZy's round backups cannot be told apart and will not cross the link");
        }

        _poll = _world.Clock.Every(PollIntervalMs, Poll);
    }

    private void OnReleased(string? reason)
    {
        Disarm();
        _active = false;
        _serial = 0;
    }

    private void Disarm()
    {
        _poll?.Cancel();
        _poll = null;
        _backupScan?.Cancel();
        _backupScan = null;
    }

    // ------------------------------------------------------------------ pauses

    private void Poll()
    {
        if (!_active || _world.Rules is not { } rules)
        {
            return;
        }

        if (rules.SwitchingTeamsAtRoundReset)
        {
            _pendingSwap = true;
        }

        var standing = rules.Standing;
        if (standing && !_standing)
        {
            var (kind, pausedBy) = Describe(rules);
            _runtime.Emit(_runtime.Facts.MatchPaused(kind, pausedBy));
        }
        else if (!standing && _standing)
        {
            _runtime.Emit(_runtime.Facts.MatchUnpaused());
            _adminPause = false;
        }

        _standing = standing;
    }

    /// <summary>What kind of pause the gamerules describe, and who asked, where that can be known.</summary>
    private (PauseKind? Kind, PauseSource? PausedBy) Describe(GameRules rules)
    {
        if (rules.TechnicalTimeout)
        {
            return (PauseKind.Technical, null);
        }

        if (rules.TerroristTimeout || rules.CounterTerroristTimeout)
        {
            var team = _runtime.Match.TeamOf(rules.TerroristTimeout ? PlayerTeam.Terrorist : PlayerTeam.CounterTerrorist);
            return (PauseKind.Tactical, team switch
            {
                MatchTeam.TeamA => PauseSource.TeamA,
                MatchTeam.TeamB => PauseSource.TeamB,
                _ => null,
            });
        }

        return _adminPause ? (PauseKind.Admin, PauseSource.Admin) : (null, null);
    }

    // ------------------------------------------------------------------ commands

    /// <summary>The runtime's command hook: <c>pause</c> and <c>unpause</c> are MatchZy's admin verbs for this flow; everything else is somebody else's.</summary>
    public CommandAnswer? OnCommand(LinkCommand command)
    {
        if (!_active)
        {
            return null;
        }

        switch (command)
        {
            case PauseCommand:
                _adminPause = true;
                _world.ExecCommand("css_forcepause");
                return CommandAnswer.Applied;
            case UnpauseCommand:
                _world.ExecCommand("css_forceunpause");
                return CommandAnswer.Applied;
            default:
                return null;
        }
    }

    // ------------------------------------------------------------------ rounds

    private void OnRoundStarted()
    {
        if (!_active || _runtime.Assignment is not { } assignment)
        {
            return;
        }

        var rules = _world.Rules;
        if (rules is { Warmup: true })
        {
            _pendingSwap = false;
            return;
        }

        var context = _runtime.Match;
        if (RosteredSide(assignment) is { } observed)
        {
            if (observed != context.TeamASide)
            {
                _runtime.Emit(_runtime.Facts.SideSwap(observed));
            }
        }
        else if (_pendingSwap)
        {
            _runtime.Emit(_runtime.Facts.SideSwap(context.TeamASide == TeamSide.Ct ? TeamSide.T : TeamSide.Ct));
        }

        _pendingSwap = false;

        if (_serial != 0)
        {
            _backupScan?.Cancel();
            _backupScan = _world.Clock.After(BackupSettleMs, ScanBackups);
        }
    }

    /// <summary>The side most of team A's rostered players stand on, or <c>null</c> when none of them is on a side (or they split evenly).</summary>
    private TeamSide? RosteredSide(Assignment assignment)
    {
        var ct = 0;
        var t = 0;
        foreach (var player in _world.Players)
        {
            if (assignment.RosteredTeamOf(player.SteamId64) != MatchTeam.TeamA)
            {
                continue;
            }

            switch (player.Team)
            {
                case PlayerTeam.CounterTerrorist:
                    ct++;
                    break;
                case PlayerTeam.Terrorist:
                    t++;
                    break;
                default:
                    break;
            }
        }

        if (ct == t)
        {
            return null;
        }

        return ct > t ? TeamSide.Ct : TeamSide.T;
    }

    // ------------------------------------------------------------------ backups

    private void ScanBackups()
    {
        _backupScan = null;
        if (!_active || _runtime.Assignment is not { } assignment)
        {
            return;
        }

        var folder = Path.Combine(_csgoDirectory, MatchZyBackups.Folder);
        var mapIndex = (int)_runtime.Match.MapNumber - 1;
        if (MatchZyBackups.Newest(folder, _serial, mapIndex) is not { } found || found.FileName == _lastBackup)
        {
            return;
        }

        string content;
        try
        {
            content = MatchZyBackups.Scrub(File.ReadAllText(found.Path));
        }
        catch (IOException error)
        {
            _log.Warn($"could not read MatchZy's backup {found.FileName}: {error.Message}");
            return;
        }

        if (content.Length > ProtocolConstants.BackupContentMax)
        {
            _log.Warn($"MatchZy's backup {found.FileName} is {content.Length} characters, above the link's {ProtocolConstants.BackupContentMax}; not sent");
            _lastBackup = found.FileName;
            return;
        }

        var roundNumber = found.RoundsCompleted + 1;
        _lastBackup = found.FileName;
        _runtime.Link.SendBackup(assignment.MatchId, new RoundBackup
        {
            MapNumber = _runtime.Match.MapNumber,
            RoundNumber = roundNumber,
            Filename = found.FileName,
            Content = content,
        });
        _runtime.Emit(_runtime.Facts.BackupWritten(roundNumber, found.FileName));
    }
}
