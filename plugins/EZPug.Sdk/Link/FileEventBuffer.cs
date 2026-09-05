using System.Text.Json;
using EZPug.Sdk.Protocol;

namespace EZPug.Sdk;

/// <summary>
/// <b>The on-disk buffer</b> (PRD-02 T7): two append-only files in one directory.
/// <c>events.jsonl</c> starts with a header line <c>{"lastSeq":n}</c> and carries one
/// <see cref="SequencedEvent"/> per line after it; <c>acked.log</c> carries one acked
/// seq per line. Loading replays both; the header keeps <see cref="LastSeq"/> honest
/// after a compaction removed every line. Compaction — the header rewritten, only the
/// pending lines kept, the ack log truncated — runs when the ack log grows past
/// <see cref="CompactAfterAcks"/>, so a long match neither grows the file without
/// bound nor rewrites it per event. A line that does not parse (a crash mid-write) is
/// skipped and reported through <see cref="Skipped"/>, never thrown: a server must
/// come up. Every write is flushed before the call returns.
/// </summary>
public sealed class FileEventBuffer : IEventBuffer, IDisposable
{
    public const int CompactAfterAcks = 500;

    private readonly string _eventsPath;
    private readonly string _ackedPath;
    private readonly List<SequencedEvent> _pending = [];
    private readonly object _gate = new();
    private FileStream _events;
    private FileStream _acked;
    private long _lastSeq;
    private int _acksSinceCompaction;

    private sealed record Header([property: System.Text.Json.Serialization.JsonPropertyName("lastSeq")] long LastSeq);

    public FileEventBuffer(string directory)
    {
        Directory.CreateDirectory(directory);
        _eventsPath = Path.Combine(directory, "events.jsonl");
        _ackedPath = Path.Combine(directory, "acked.log");
        var fresh = !File.Exists(_eventsPath);
        Load();
        _events = Open(_eventsPath);
        _acked = Open(_ackedPath);
        if (fresh)
        {
            WriteLine(_events, JsonSerializer.Serialize(new Header(0)));
        }

        if (_acksSinceCompaction > 0)
        {
            Compact();
        }
    }

    /// <summary>Lines the loader could not read, for the plugin's log.</summary>
    public int Skipped { get; private set; }

    public long LastSeq
    {
        get
        {
            lock (_gate)
            {
                return _lastSeq;
            }
        }
    }

    public IReadOnlyList<SequencedEvent> Pending()
    {
        lock (_gate)
        {
            return _pending.ToList();
        }
    }

    public SequencedEvent Append(GameserverEvent gameserverEvent)
    {
        lock (_gate)
        {
            var sequenced = new SequencedEvent { Seq = ++_lastSeq, Event = gameserverEvent };
            _pending.Add(sequenced);
            WriteLine(_events, ProtocolJson.Serialize(sequenced));
            return sequenced;
        }
    }

    public void Acked(long seq)
    {
        lock (_gate)
        {
            if (_pending.RemoveAll(entry => entry.Seq == seq) == 0)
            {
                return;
            }

            WriteLine(_acked, seq.ToString(System.Globalization.CultureInfo.InvariantCulture));
            if (++_acksSinceCompaction >= CompactAfterAcks)
            {
                Compact();
            }
        }
    }

    public void AckedThrough(long seq)
    {
        lock (_gate)
        {
            foreach (var entry in _pending.Where(entry => entry.Seq <= seq).ToList())
            {
                Acked(entry.Seq);
            }
        }
    }

    /// <summary>Rewrite the files to what is pending now. Public for a test; called on its own past the threshold.</summary>
    public void Compact()
    {
        lock (_gate)
        {
            _events.Dispose();
            _acked.Dispose();
            var temporary = _eventsPath + ".tmp";
            using (var fresh = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                WriteLine(fresh, JsonSerializer.Serialize(new Header(_lastSeq)));
                foreach (var entry in _pending)
                {
                    WriteLine(fresh, ProtocolJson.Serialize(entry));
                }
            }

            File.Move(temporary, _eventsPath, overwrite: true);
            File.WriteAllText(_ackedPath, "");
            _events = Open(_eventsPath);
            _acked = Open(_ackedPath);
            _acksSinceCompaction = 0;
        }
    }

    private void Load()
    {
        var acked = new HashSet<long>();
        if (File.Exists(_ackedPath))
        {
            foreach (var line in File.ReadLines(_ackedPath))
            {
                if (long.TryParse(line, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var seq))
                {
                    acked.Add(seq);
                }
                else if (line.Length > 0)
                {
                    Skipped++;
                }
            }
        }

        _acksSinceCompaction = acked.Count;
        if (!File.Exists(_eventsPath))
        {
            return;
        }

        var first = true;
        foreach (var line in File.ReadLines(_eventsPath))
        {
            if (line.Length == 0)
            {
                continue;
            }

            if (first)
            {
                first = false;
                if (TryReadHeader(line, out var headerLastSeq))
                {
                    _lastSeq = Math.Max(_lastSeq, headerLastSeq);
                    continue;
                }
            }

            try
            {
                var entry = ProtocolJson.Deserialize<SequencedEvent>(line);
                _lastSeq = Math.Max(_lastSeq, entry.Seq);
                if (!acked.Contains(entry.Seq))
                {
                    _pending.Add(entry);
                }
            }
            catch (JsonException)
            {
                Skipped++;
            }
        }

        _pending.Sort((a, b) => a.Seq.CompareTo(b.Seq));
    }

    private static bool TryReadHeader(string line, out long lastSeq)
    {
        lastSeq = 0;
        try
        {
            using var document = JsonDocument.Parse(line);
            if (document.RootElement.ValueKind == JsonValueKind.Object
                && document.RootElement.TryGetProperty("lastSeq", out var value)
                && value.TryGetInt64(out lastSeq))
            {
                return true;
            }
        }
        catch (JsonException)
        {
            // Not a header; the caller reads it as a line and counts it if it is torn.
        }

        return false;
    }

    private static FileStream Open(string path) =>
        new(path, FileMode.Append, FileAccess.Write, FileShare.Read);

    private static void WriteLine(FileStream stream, string line)
    {
        var bytes = System.Text.Encoding.UTF8.GetBytes(line + "\n");
        stream.Write(bytes, 0, bytes.Length);
        // To the OS, not to the platter: a process crash loses nothing, an OS crash a few events the orchestrator never acked anyway — and a position tick every 100 ms cannot afford an fsync each.
        stream.Flush();
    }

    public void Dispose()
    {
        lock (_gate)
        {
            _events.Dispose();
            _acked.Dispose();
        }
    }
}
