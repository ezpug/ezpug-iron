using System.Text.Json.Nodes;
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
/// when MatchZy itself says "paused" in chat. The command's own answer is the gamerules'
/// too (PRD-04 T4): <c>applied</c> only once they say paused, <c>invalid_state</c> with a
/// reason when MatchZy refused — see <see cref="Ask"/>.</item>
/// <item><c>side_swap</c> at a round start, when the rostered team A stands on another
/// side than the context holds — a knife winner's <c>.switch</c> and halftime alike — or,
/// with nobody rostered (bots), when the engine said it swaps at the round reset.</item>
/// <item>a <c>backup</c> frame and <c>backup_written</c> a moment after a live round starts,
/// from the newest file MatchZy wrote for this match and map, scrubbed of the token
/// (<see cref="MatchZyBackups"/>).</item>
/// <item>a <c>restore</c> relayed over the link on a live match (PRD-04 T8), answered
/// with MatchZy's own <c>matchzy_loadbackup</c> and, like a pause, by what the engine
/// did — see <see cref="Restore"/>.</item>
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

    /// <summary>
    /// How long the gamerules are watched after <c>css_forcepause</c> before the command
    /// is refused. MatchZy's own <c>mp_pause_match</c> is a queued console command, so
    /// the flag turns over a frame later; a whole second of polls is generous and stays
    /// far inside the orchestrator's fifteen-second command deadline, which means the
    /// client that asked is still holding the HTTP call when the answer lands.
    /// </summary>
    public const long PauseAnswerMs = 1_000;

    /// <summary>
    /// How long the engine is watched after <c>matchzy_loadbackup</c> for the restored
    /// round to start. MatchZy runs <c>mp_backup_restore_load_file</c> on its next timer
    /// tick and the engine restarts the round from the file at once — the whole
    /// <c>restore</c> call took 268 ms end to end on the dev node (PRD-04 T8) — so the
    /// beat is headroom for a loaded box, not the wait, and it still ends well inside the
    /// orchestrator's fifteen-second command deadline.
    /// </summary>
    public const long RestoreAnswerMs = 8_000;

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
    private PendingAnswer? _pending;
    private PendingRestore? _restore;
    private string? _restoreSeen;
    private long _roundStarts;
    private bool _roundOver;

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
        _world.RoundEnded += OnRoundEnded;
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
        _roundOver = false;
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
        // A watched pause outlives nothing: answer it now rather than leave the client
        // on the orchestrator's deadline for a match that no longer exists.
        if (_pending is { } pending)
        {
            _pending = null;
            _runtime.Link.AnswerCommand(pending.CorrelationId, Refused(PauseRefusal.Released));
        }

        if (_restore is { } restore)
        {
            _restore = null;
            _runtime.Link.AnswerCommand(restore.CorrelationId, RestoreRefused(PauseRefusal.Released));
        }

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

        // After the fact, never before it: the pause is on its way to the orchestrator
        // before the answer that claims it is, whatever the two pipes do to them next.
        Settle(rules);
        SettleRestore(rules);
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

    /// <summary>The runtime's command hook: <c>pause</c>, <c>unpause</c> and <c>restore</c> are MatchZy's admin verbs for this flow; everything else is somebody else's.</summary>
    public CommandAnswer? OnCommand(LinkCommand command)
    {
        if (!_active)
        {
            return null;
        }

        return command switch
        {
            PauseCommand pause => Ask(pause.CorrelationId, wanted: true),
            UnpauseCommand unpause => Ask(unpause.CorrelationId, wanted: false),
            RestoreCommand restore => Restore(restore.CorrelationId, restore.RoundNumber),
            _ => null,
        };
    }

    /// <summary>
    /// <b>A pause that says no</b> (PRD-04 T4, OPEN-POINTS §6). MatchZy's
    /// <c>ForcePauseMatch</c> returns early at halftime, after the last round and during
    /// a tactical timeout, and says so only in chat — so relaying the command and
    /// answering <c>applied</c> because it ran told the platform's admin console that a
    /// match it never paused was paused. The answer is the server's instead: the verb
    /// runs, the gamerules are watched for <see cref="PauseAnswerMs"/>, and
    /// <c>applied</c> means <c>mp_pause_match</c> actually took hold — anything else is
    /// <c>invalid_state</c> with a <see cref="PauseRefusal"/> naming what the gamerules
    /// said when the beat ran out.
    ///
    /// The one thing the beat cannot judge is a match that is already standing where it
    /// was asked to stand: "did it become paused" has no answer when it was paused to
    /// begin with (a tactical timeout holds <c>m_bMatchWaitingForResume</c> too). Those
    /// two are decided up front, the way MatchZy decides them itself, and the verb is
    /// never sent.
    /// </summary>
    private CommandAnswer Ask(string correlationId, bool wanted)
    {
        // Two asks in flight would race for one field; the older one is answered from
        // what the gamerules say right now rather than left for the link's deadline.
        Settle(_world.Rules, dueOnly: false);

        if (_world.Rules is not { } rules)
        {
            return Refused(PauseRefusal.NoGamerules);
        }

        if (wanted && rules.Paused)
        {
            return Refused(rules.Timeout ? PauseRefusal.TimeoutActive : PauseRefusal.AlreadyPaused);
        }

        if (!wanted && !rules.Standing)
        {
            return Refused(PauseRefusal.NotPaused);
        }

        if (wanted)
        {
            _adminPause = true;
        }

        _world.ExecCommand(wanted ? "css_forcepause" : "css_forceunpause");
        _pending = new PendingAnswer(correlationId, wanted, _world.Clock.NowMs + PauseAnswerMs);
        return CommandAnswer.Deferred;
    }

    /// <summary>
    /// Answer a watched pause, if the gamerules have decided it. <paramref name="dueOnly"/>
    /// false forces a verdict now — a second command, or the match going away under it.
    /// </summary>
    private void Settle(GameRules? rules, bool dueOnly = true)
    {
        if (_pending is not { } pending)
        {
            return;
        }

        if (rules is { } read && Took(read, pending.Wanted))
        {
            _pending = null;
            _runtime.Link.AnswerCommand(pending.CorrelationId, CommandAnswer.Applied);
            return;
        }

        if (dueOnly && rules is not null && _world.Clock.NowMs < pending.DueAtMs)
        {
            return;
        }

        _pending = null;
        if (pending.Wanted)
        {
            // Nothing the admin asked for happened, so the next pause is not theirs.
            _adminPause = false;
        }

        _runtime.Link.AnswerCommand(pending.CorrelationId, Refused(Diagnose(rules, pending.Wanted)));
    }

    /// <summary>
    /// Whether the verb took. A pause is <c>mp_pause_match</c> alone — a tactical timeout
    /// that arrived in the meantime is not the admin's doing and must not read as their
    /// pause — while an unpause has to leave the match running, whatever was holding it.
    /// </summary>
    private static bool Took(GameRules rules, bool wanted) => wanted ? rules.Paused : !rules.Standing;

    /// <summary>Why nothing moved, as far as the gamerules can say. Best effort by design: the verdict is the observation, this is only the word for it.</summary>
    private static PauseRefusal Diagnose(GameRules? rules, bool wanted)
    {
        if (rules is not { } read)
        {
            return PauseRefusal.NoGamerules;
        }

        return read.Phase switch
        {
            GamePhase.Halftime => PauseRefusal.Halftime,
            GamePhase.MatchEnded => PauseRefusal.PostGame,
            _ when read.Timeout => PauseRefusal.TimeoutActive,
            _ when wanted && (read.Warmup || read.Phase == GamePhase.WarmupRound) => PauseRefusal.NotLive,
            _ => PauseRefusal.Unknown,
        };
    }

    /// <summary>
    /// Every refusal is <c>invalid_state</c> — the command was understood and the match
    /// was in no state for it — and the message names the reason first, so a client reads
    /// one word before the sentence (<c>docs/match-api.md</c>, the command table).
    /// </summary>
    private static CommandAnswer Refused(PauseRefusal refusal) =>
        CommandAnswer.Rejected(MatchApiErrorCode.InvalidState, $"{Word(refusal)}: {Sentence(refusal)}");

    /// <summary>The reason word a client matches on. The set is closed and documented; a new one is a documented one.</summary>
    public static string Word(PauseRefusal refusal) =>
        refusal switch
        {
            PauseRefusal.AlreadyPaused => "already_paused",
            PauseRefusal.NotPaused => "not_paused",
            PauseRefusal.Halftime => "halftime",
            PauseRefusal.PostGame => "post_game",
            PauseRefusal.TimeoutActive => "timeout_active",
            PauseRefusal.NotLive => "not_live",
            PauseRefusal.Released => "released",
            PauseRefusal.NoGamerules => "no_gamerules",
            PauseRefusal.RoundOver => "round_over",
            _ => "unknown",
        };

    private static string Sentence(PauseRefusal refusal) =>
        refusal switch
        {
            PauseRefusal.AlreadyPaused => "the match is already standing",
            PauseRefusal.NotPaused => "the match is not paused",
            PauseRefusal.Halftime => "the match software refuses a pause during halftime",
            PauseRefusal.PostGame => "the match is over",
            PauseRefusal.TimeoutActive => "a timeout is running and holds the match",
            PauseRefusal.NotLive => "the match is not live yet",
            PauseRefusal.Released => "the match was released before the server answered",
            PauseRefusal.NoGamerules => "the server has no map loaded to pause",
            PauseRefusal.RoundOver => "the round is over and the next has not started",
            _ => "nothing paused and the gamerules name no reason",
        };

    /// <summary>A pause command relayed to MatchZy, waiting for the gamerules to say whether it took.</summary>
    private readonly record struct PendingAnswer(string CorrelationId, bool Wanted, long DueAtMs);

    // ------------------------------------------------------------------ restores

    /// <summary>
    /// <b>A rewind on the server that is playing</b> (PRD-04 T8): the LAN case, a round a
    /// player's machine crashed in, played again from its start. The orchestrator names
    /// the round (it resolved "the latest" from the backups this server sent); the file is
    /// the one MatchZy wrote here at that round's start, and <c>matchzy_loadbackup</c> is
    /// MatchZy's own restore — its sides, its timeouts, its pause after a restore
    /// (<c>matchzy_pause_after_restore</c>, which an <c>unpause</c> lifts).
    ///
    /// MatchZy refuses a restore at halftime, after the last round and during a tactical
    /// timeout, and says so only in chat — so, as for a pause, the answer is what the
    /// engine did: <c>applied</c> once a round has started since the verb with the
    /// rounds played the file was written at, otherwise <c>invalid_state</c> with a
    /// <see cref="PauseRefusal"/> word once <see cref="RestoreAnswerMs"/> runs out. The
    /// round start is the proof and the rounds played alone are not: a restore of the
    /// round being played leaves them where they were, and a load the engine never
    /// restarts from (below) moves them all the same.
    ///
    /// Three things are decided up front and the verb never sent: a file that is not on
    /// this server (<c>no_backup</c>); a match in warmup, where MatchZy would not refuse
    /// but hold the file for the next match start — a restore nobody asked for; and
    /// <b>a round that is over while the next has not started</b>. Measured on the dev
    /// node (PRD-04 T8): asked mid-round, the engine ends the round and restarts it from
    /// the file within a quarter of a second; asked in the gap after a round, MatchZy
    /// accepts, the engine logs "Loaded server checkpoint … starting match with score 1:0
    /// after round 1", takes the rounds played back — and stays in its round-over state
    /// for good, the restart it was waiting for gone. Seven minutes and an unpause later
    /// the match had not moved. MatchZy's own <c>.stop</c> restore is cancelled when the
    /// round ends for the same reason, so the gap is refused with <c>round_over</c> (or
    /// the phase's own word at halftime and after the last round) and the caller asks
    /// again once the next round is under way.
    /// </summary>
    private CommandAnswer Restore(string correlationId, long? roundNumber)
    {
        SettleRestore(_world.Rules, dueOnly: false);

        if (_world.Rules is not { } rules)
        {
            return RestoreRefused(PauseRefusal.NoGamerules);
        }

        var folder = Path.Combine(_csgoDirectory, MatchZyBackups.Folder);
        var mapIndex = (int)_runtime.Match.MapNumber - 1;
        var found = _serial == 0
            ? null
            : roundNumber is { } round
                ? MatchZyBackups.Find(folder, _serial, mapIndex, (int)round - 1)
                : MatchZyBackups.Newest(folder, _serial, mapIndex);
        if (found is null)
        {
            return CommandAnswer.Rejected(
                MatchApiErrorCode.NoBackup,
                roundNumber is { } missing ? $"no backup of round {missing} of this map on the server" : "no backup of this map on the server");
        }

        if (rules.Warmup)
        {
            return RestoreRefused(PauseRefusal.NotLive);
        }

        if (_roundOver)
        {
            return RestoreRefused(rules.Phase switch
            {
                GamePhase.Halftime => PauseRefusal.Halftime,
                GamePhase.MatchEnded => PauseRefusal.PostGame,
                _ => PauseRefusal.RoundOver,
            });
        }

        _world.ExecCommand($"matchzy_loadbackup {found.FileName}");
        _restore = new PendingRestore(correlationId, found, _roundStarts, _world.Clock.NowMs, _world.Clock.NowMs + RestoreAnswerMs);
        _restoreSeen = Describe(rules, 0);
        _log.Info($"restore of round {found.RoundsCompleted + 1} from {found.FileName} asked: {_restoreSeen}");
        return CommandAnswer.Deferred;
    }

    /// <summary>What the engine looked like while a restore is watched — said on the console once per change, so a verdict can be argued with from the server's own log.</summary>
    private string Describe(GameRules rules, long roundStarts) =>
        $"rounds played {rules.RoundsPlayed}, {(rules.Paused ? "paused" : "running")}, phase {rules.Phase}, {roundStarts} round start(s) since";

    /// <summary>Answer a watched restore, if the engine has decided it; <paramref name="dueOnly"/> false forces a verdict now.</summary>
    private void SettleRestore(GameRules? rules, bool dueOnly = true)
    {
        if (_restore is not { } pending)
        {
            return;
        }

        if (rules is { } seen && Describe(seen, _roundStarts - pending.RoundStartsBefore) is var now && now != _restoreSeen)
        {
            _restoreSeen = now;
            _log.Info($"restore of round {pending.Backup.RoundsCompleted + 1} watched after {_world.Clock.NowMs - pending.AskedAtMs} ms: {now}");
        }

        if (rules is { } read && Took(read, pending))
        {
            _restore = null;
            Restored(pending);
            return;
        }

        if (dueOnly && rules is not null && _world.Clock.NowMs < pending.DueAtMs)
        {
            return;
        }

        _restore = null;
        // A restore, like a pause, needs a live match: the diagnosis is the same one.
        var refusal = Diagnose(rules, wanted: true);
        _log.Warn($"restore of round {pending.Backup.RoundsCompleted + 1} refused ({Word(refusal)}) after {_world.Clock.NowMs - pending.AskedAtMs} ms: {_restoreSeen}");
        _runtime.Link.AnswerCommand(pending.CorrelationId, RestoreRefused(refusal));
    }

    /// <summary>Whether the engine is playing the backup's round: one has started since the ask, at the rounds played the file was written at.</summary>
    private bool Took(GameRules rules, PendingRestore pending) =>
        _roundStarts > pending.RoundStartsBefore && rules.RoundsPlayed == pending.Backup.RoundsCompleted;

    /// <summary>
    /// The round is back. What MatchZy wrote after it belongs to rounds that no longer
    /// happened, so its files go — the orchestrator forgets its copies on the same
    /// answer — and the next backup this server sends is the replay's own. The fact is
    /// the one a restored replacement says (<see cref="GamemodeLoader.BackupRestoredEvent"/>),
    /// emitted before the answer.
    /// </summary>
    private void Restored(PendingRestore pending)
    {
        var folder = Path.Combine(_csgoDirectory, MatchZyBackups.Folder);
        var mapIndex = (int)_runtime.Match.MapNumber - 1;
        foreach (var later in MatchZyBackups.Of(folder, _serial, mapIndex).Where(found => found.RoundsCompleted > pending.Backup.RoundsCompleted).ToList())
        {
            try
            {
                File.Delete(later.Path);
            }
            catch (IOException error)
            {
                _log.Warn($"could not forget MatchZy's backup {later.FileName} after the restore: {error.Message}");
            }
        }

        _lastBackup = pending.Backup.FileName;
        var roundNumber = (long)pending.Backup.RoundsCompleted + 1;
        _log.Info($"restored map {_runtime.Match.MapNumber} round {roundNumber} from {pending.Backup.FileName} after {_world.Clock.NowMs - pending.AskedAtMs} ms: {_restoreSeen}");
        _runtime.Emit(_runtime.Facts.Plugin(GamemodeLoader.BackupRestoredEvent, new JsonObject
        {
            ["mapNumber"] = _runtime.Match.MapNumber,
            ["roundNumber"] = roundNumber,
            ["filename"] = pending.Backup.FileName,
        }));
        _runtime.Link.AnswerCommand(pending.CorrelationId, CommandAnswer.Applied);
    }

    private static CommandAnswer RestoreRefused(PauseRefusal refusal) =>
        CommandAnswer.Rejected(MatchApiErrorCode.InvalidState, $"{Word(refusal)}: {RestoreSentence(refusal)}");

    private static string RestoreSentence(PauseRefusal refusal) =>
        refusal switch
        {
            PauseRefusal.Halftime => "the match software refuses a restore during halftime",
            PauseRefusal.PostGame => "the match is over",
            PauseRefusal.TimeoutActive => "a timeout is running and holds the match",
            PauseRefusal.NotLive => "the match is not live yet",
            PauseRefusal.Released => "the match was released before the server answered",
            PauseRefusal.NoGamerules => "the server has no map loaded to restore on",
            PauseRefusal.RoundOver => "the round is over and the next has not started; ask again once it has",
            _ => "no round was restored and the gamerules name no reason",
        };

    /// <summary>A backup handed to MatchZy, waiting for the engine to start the round it holds.</summary>
    private readonly record struct PendingRestore(string CorrelationId, MatchZyBackups.Found Backup, long RoundStartsBefore, long AskedAtMs, long DueAtMs);

    // ------------------------------------------------------------------ rounds

    private void OnRoundStarted()
    {
        if (!_active || _runtime.Assignment is not { } assignment)
        {
            return;
        }

        _roundStarts++;
        _roundOver = false;
        SettleRestore(_world.Rules);

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

    private void OnRoundEnded(RoundEnd end)
    {
        if (_active)
        {
            _roundOver = true;
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

/// <summary>
/// <b>Why a pause did not happen</b> (PRD-04 T4). MatchZy says its refusal in chat and
/// nowhere a plugin can read, so these are what the gamerules looked like when the beat
/// ran out — a diagnosis, not a quote. The verdict itself is never a guess: it is whether
/// <c>mp_pause_match</c> moved. Every one of them crosses the link as
/// <c>invalid_state</c> with the word in front of the message; the words are the closed
/// set <c>docs/match-api.md</c> lists.
/// </summary>
public enum PauseRefusal
{
    /// <summary>Nothing paused and the gamerules name no reason — MatchZy refused for something only it knows.</summary>
    Unknown,
    /// <summary>A pause asked for a match that is already standing.</summary>
    AlreadyPaused,
    /// <summary>An unpause asked for a match that is running.</summary>
    NotPaused,
    /// <summary>The break between the halves; MatchZy refuses a pause there.</summary>
    Halftime,
    /// <summary>The match is over and the scoreboard is up.</summary>
    PostGame,
    /// <summary>A tactical or technical timeout is holding the match.</summary>
    TimeoutActive,
    /// <summary>The match has not started; there is nothing to pause.</summary>
    NotLive,
    /// <summary>The match was released while the answer was being watched for.</summary>
    Released,
    /// <summary>No map is loaded, so nothing could be read or asked.</summary>
    NoGamerules,
    /// <summary>A round has ended and the next has not started — the gap a restore cannot land in (PRD-04 T8).</summary>
    RoundOver,
}
