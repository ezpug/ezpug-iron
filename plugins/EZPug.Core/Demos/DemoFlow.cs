using EZPug.Sdk;
using EZPug.Sdk.Protocol;

namespace EZPug.Core;

/// <summary>
/// <b>Demos over the link's shoulder</b> (decision 10, PRD-02 T21). For a gamemode whose
/// manifest says <c>records: demo</c> this class does the two things nobody else can:
///
/// <list type="bullet">
/// <item><b>Recording, where nothing else records.</b> A <c>matchzy</c> flow has MatchZy
/// running <c>tv_record</c> on its own schedule (and stopping it a GOTV delay after the
/// map, so the demo carries the last rounds); any other flow has nobody, so the SDK runs
/// the two commands itself — <c>tv_record</c> when the assignment's map is up, and
/// <c>tv_stoprecord</c> one GOTV delay after the win panel.</item>
/// <item><b>The upload, always.</b> MatchZy's own uploader POSTs a multipart form, which
/// is not what a presigned PUT takes, so the file goes up from here: streamed, hashed and
/// retried by <see cref="DemoUploader"/>, at the assignment's <c>demoUploadUrl</c>. What
/// landed is announced as <c>demo_available</c> with its size and hash, and that pair is
/// the orchestrator's cue to relay <c>demo.uploaded</c> to the client.</item>
/// </list>
///
/// <b>One demo per upload URL.</b> A request that drew one presigned URL per map
/// (<c>callbacks.demoUploadUrls</c>, PRD-02 T38a) hands over every map's demo, each at its
/// own; a request with the single <c>demoUploadUrl</c> hands over the first map's only,
/// because a second PUT at the same presigned URL would overwrite it in the client's
/// storage. The maps that stay behind are said so in the log.
///
/// <b>Knowing when the file is finished is the whole difficulty.</b> GOTV keeps writing
/// until <c>tv_stoprecord</c> and says nothing when it stops — there is no event, no
/// forward and no cvar to read (MatchZy 0.8.15 has no in-process forwards at all). So
/// from the win panel on, the newest <c>.dem</c> is looked at every
/// <see cref="PollIntervalMs"/> and taken for finished when its length has not moved for
/// <see cref="SettleMs"/>. The orchestrator holds the match open for this
/// (<c>deadlines.demoMs</c>); <see cref="WindowMs"/> is the plugin's own patience, and
/// it is deliberately the shorter of the two so the plugin gives up first and the match
/// ends on a demo that is announced rather than on a deadline.
/// </summary>
public sealed class DemoFlow
{
    /// <summary>How often the demo folder is looked at once the map is over.</summary>
    public const long PollIntervalMs = 5_000;

    /// <summary>How long a demo's length must stand still before nothing is writing to it any more.</summary>
    public const long SettleMs = 15_000;

    /// <summary>
    /// How long after the win panel the plugin keeps looking for a demo. It has to cover
    /// the GOTV delay MatchZy waits out (105 s on a pug) plus <see cref="SettleMs"/> plus
    /// one poll, with room for a server that is busy changing level underneath it.
    /// </summary>
    public const long WindowMs = 4 * 60_000;

    /// <summary>The GOTV delay assumed when <c>tv_delay</c> cannot be read, in seconds.</summary>
    public const int DefaultTvDelaySeconds = 105;

    private readonly IGameWorld _world;
    private readonly GamemodeRuntime _runtime;
    private readonly string _csgoDirectory;
    private readonly DemoUploader _uploader;
    private readonly ILinkLog _log;

    private bool _records;
    private bool _ownsRecording;
    private Assignment? _assignment;
    /// <summary>The map whose demo is being recorded and handed over — read when the map loads, not when the file is found, because the context has moved on by then.</summary>
    private long _mapNumber = 1;
    /// <summary>Every presigned URL this match has already PUT a demo at; a second one would overwrite it.</summary>
    private readonly HashSet<string> _uploaded = new(StringComparer.Ordinal);
    private Uri? _uploadUrl;
    private string? _folder;
    private string? _marker;
    private string? _recordingAs;
    private IClockTimer? _poll;
    private IClockTimer? _stop;
    private long _deadlineMs;
    private long _length = -1;
    private long _steadySinceMs;
    private bool _done;

    public DemoFlow(IGameWorld world, GamemodeRuntime runtime, string csgoDirectory, DemoUploader uploader, ILinkLog? log = null)
    {
        _world = world;
        _runtime = runtime;
        _csgoDirectory = csgoDirectory;
        _uploader = uploader;
        _log = log ?? NullLinkLog.Instance;
    }

    /// <summary>Whether a match that records a demo is assigned right now.</summary>
    public bool Active => _records;

    /// <summary>Whether the SDK, rather than MatchZy, is running <c>tv_record</c> for this match.</summary>
    public bool OwnsRecording => _ownsRecording;

    /// <summary>Where this match's demo is looked for; <c>null</c> while nothing is assigned.</summary>
    public string? Folder => _folder;

    public void Bind()
    {
        _runtime.Assigned += OnAssigned;
        _runtime.MapLoaded += OnMapLoaded;
        _runtime.Released += OnReleased;
        _world.MapEnded += OnMapEnded;
    }

    private void OnAssigned(Assignment assignment)
    {
        Disarm();
        _records = assignment.Gamemode.Records == GamemodeRecords.Demo;
        _ownsRecording = false;
        _assignment = assignment;
        _mapNumber = _runtime.Match.MapNumber;
        _uploaded.Clear();
        _uploadUrl = null;
        _folder = null;
        _marker = null;
        _recordingAs = null;
        _length = -1;
        _done = false;
        if (!_records)
        {
            return;
        }

        _ownsRecording = assignment.Gamemode.Flow != GamemodeFlow.Matchzy;
        _folder = _ownsRecording
            ? _csgoDirectory
            : Path.Combine(_csgoDirectory, DemoFiles.MatchZyFolder);
        // MatchZy puts the match's own `matchid` in every demo name, so a server that
        // played twice cannot hand over the wrong match's file. Ours carries the same
        // marker for the same reason.
        _marker = MatchZySerial(assignment) is { } serial ? serial.ToString() : null;
        // Resolved per map at the win panel (`UrlFor`); this is only whether the request
        // named anywhere at all, which is worth saying while somebody is still watching.
        if (assignment.DemoUploadUrl is null && (assignment.DemoUploadUrls?.Count ?? 0) == 0)
        {
            _log.Warn("this match records a demo and the request named nowhere to put one; it will stay on this server");
        }
    }

    private void OnMapLoaded(Assignment assignment, string map)
    {
        if (!_records)
        {
            return;
        }

        // Read here and nowhere else: by the time the file is finished the runtime has
        // counted the map that ended, and this demo belongs to the one that just played.
        _mapNumber = _runtime.Match.MapNumber;
        if (!_ownsRecording)
        {
            return;
        }

        // A flat name under `game/csgo`: `tv_record` takes a path relative to it and
        // will not create a folder that is not there.
        _recordingAs = $"ezpug_{_marker ?? "match"}_map{_runtime.Match.MapNumber}";
        _marker = _recordingAs;
        _world.ExecCommand($"tv_record {_recordingAs}");
        _log.Info($"recording this map's demo as {_recordingAs}.dem");
    }

    private void OnReleased(string? reason)
    {
        if (_records && _ownsRecording && _recordingAs is not null)
        {
            _world.ExecCommand("tv_stoprecord");
        }

        Disarm();
        _records = false;
        _ownsRecording = false;
        _assignment = null;
        _uploaded.Clear();
        _uploadUrl = null;
        _folder = null;
        _marker = null;
        _recordingAs = null;
    }

    private void Disarm()
    {
        _poll?.Cancel();
        _poll = null;
        _stop?.Cancel();
        _stop = null;
    }

    // ------------------------------------------------------------------ the map is over

    private void OnMapEnded()
    {
        if (!_records || _poll is not null)
        {
            return;
        }

        // This map's own presigned PUT, or the single one the request carried for every
        // map (`demoUploadUrlFor`, the same rule the orchestrator and the fake follow).
        var url = _assignment?.DemoUploadUrlFor((int)_mapNumber);
        if (url is { Length: > 0 } && _uploaded.Contains(url))
        {
            // A second PUT at the same presigned URL would overwrite the demo already
            // there. A request that drew one URL per map never lands here.
            _log.Warn($"map {_mapNumber} ended and this match's demoUploadUrl already holds another map's demo; this one stays on the server");
            return;
        }

        _uploadUrl = url is { Length: > 0 } && Uri.TryCreate(url, UriKind.Absolute, out var parsed) ? parsed : null;
        _done = false;
        _length = -1;

        if (_ownsRecording)
        {
            // GOTV records the *delayed* broadcast: stopping on the win panel would cut
            // the last rounds off the demo. MatchZy waits the same delay for the same
            // reason (`DemoManagement.StopDemoRecording`).
            var delayMs = TvDelaySeconds() * 1_000L;
            _stop = _world.Clock.After(delayMs, () =>
            {
                _stop = null;
                _world.ExecCommand("tv_stoprecord");
            });
        }

        _length = -1;
        _steadySinceMs = _world.Clock.NowMs;
        _deadlineMs = _world.Clock.NowMs + WindowMs;
        _poll = _world.Clock.Every(PollIntervalMs, Poll);
    }

    /// <summary>The GOTV delay in seconds, as the server has it; the competitive default when it cannot be read.</summary>
    private int TvDelaySeconds() =>
        int.TryParse(_world.GetCvar("tv_delay"), out var seconds) && seconds >= 0
            ? seconds
            : DefaultTvDelaySeconds;

    private void Poll()
    {
        if (_done || _folder is null)
        {
            return;
        }

        var now = _world.Clock.NowMs;
        var found = DemoFiles.Newest(_folder, _marker);
        if (found is null || found.Length == 0)
        {
            if (now >= _deadlineMs)
            {
                Give($"no demo appeared in {_folder} within {WindowMs} ms of the win panel");
            }

            return;
        }

        if (found.Length != _length)
        {
            _length = found.Length;
            _steadySinceMs = now;
            if (now >= _deadlineMs)
            {
                Give($"the demo {found.FileName} was still being written {WindowMs} ms after the win panel");
            }

            return;
        }

        if (now - _steadySinceMs < SettleMs)
        {
            return;
        }

        _done = true;
        Disarm();
        Upload(found);
    }

    /// <summary>Nothing to hand over. Said once, in the log; the match's ended fact carries the rest.</summary>
    private void Give(string why)
    {
        _done = true;
        Disarm();
        _log.Warn(why);
    }

    // ------------------------------------------------------------------ the upload

    private void Upload(DemoFiles.Found found)
    {
        if (_uploadUrl is not { } url)
        {
            // Nowhere to put it: say it exists, hashless. The orchestrator's ended fact
            // then reads `no_upload_url`, which is the truth about the request.
            Announce(new DemoUploadOutcome(false, found.FileName, found.Length, null, DemoFiles.ContentType, "no demoUploadUrl"));
            return;
        }

        _uploaded.Add(url.ToString());
        var task = _uploader.UploadAsync(url, found.Path);
        if (task.IsCompleted)
        {
            Announce(Outcome(task, found));
            return;
        }

        // The PUT is on the thread pool; the event it produces is not. Back on the
        // game thread through the world's own clock, where every other emit happens.
        task.ContinueWith(
            finished => _world.Clock.After(0, () => Announce(Outcome(finished, found))),
            CancellationToken.None,
            TaskContinuationOptions.ExecuteSynchronously,
            TaskScheduler.Default);
    }

    private DemoUploadOutcome Outcome(Task<DemoUploadOutcome> task, DemoFiles.Found found) =>
        task.Status == TaskStatus.RanToCompletion
            ? task.Result
            : new DemoUploadOutcome(false, found.FileName, found.Length, null, DemoFiles.ContentType, task.Exception?.GetBaseException().Message ?? "the upload did not finish");

    private void Announce(DemoUploadOutcome outcome)
    {
        if (_runtime.Assignment is null)
        {
            // The match was released while the file was going up. The bytes are in the
            // client's storage either way; nobody is left to tell.
            _log.Warn($"the demo {outcome.FileName} finished after the match was released");
            return;
        }

        if (!outcome.Uploaded && outcome.Detail is { Length: > 0 } detail)
        {
            _log.Warn($"the demo {outcome.FileName} was not uploaded: {detail}");
        }

        _runtime.Emit(_runtime.Facts.DemoAvailable(
            outcome.FileName,
            outcome.SizeBytes,
            outcome.Uploaded ? outcome.Sha256 : null,
            outcome.Uploaded ? outcome.ContentType : null,
            mapNumber: _mapNumber));
    }

    /// <summary>MatchZy's numeric <c>matchid</c> for this assignment, when it has one.</summary>
    private static long? MatchZySerial(Assignment assignment) =>
        assignment.MatchzyConfig?["matchid"] is { } matchid && long.TryParse(matchid.ToString(), out var serial)
            ? serial
            : null;
}
