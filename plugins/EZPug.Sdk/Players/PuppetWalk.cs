using System.Globalization;
using System.Numerics;

namespace EZPug.Sdk;

/// <summary>
/// <b>The movement spike's instrument</b> (PRD-03 T12). The question the task asks is
/// whether <c>Teleport</c>, called once an engine frame, moves a puppet smoothly enough
/// for the position ticks the SDK streams and the radar a platform draws from them. The
/// only honest way to answer it is to command a path nobody can argue with and read back
/// what the wire carried, so this walks every puppet on the server around a circle of its
/// own — a known radius at a known speed for a known time — and the lane compares the
/// stream's samples against the engine's own bots in the same match.
///
/// <para><b>Puppets only.</b> A body a request never named is never moved, and neither is
/// a person: a walk is a measurement of a simulated match and a cheat anywhere else. The
/// filter is <see cref="IGamePlayer.IsPuppet"/>, which is the roster's word (PRD-03 T7,
/// T7a); the operator's door in front of this refuses a match that did not ask for
/// simulation at all.</para>
///
/// <para><b>A death restarts the circle where the body wakes up.</b> The engine respawns
/// whoever it killed wherever it likes, and a walker that carried on around its old centre
/// would draw one enormous jump across the map — a snap in the measurement that says
/// nothing about teleporting. So a body that comes back alive takes its new position as
/// the centre and its phase from zero, and the count of those restarts is part of the
/// report: they are the seam in the path, and the lane knows to expect one per death.</para>
///
/// <para>Nothing here knows a map. A circle through a wall is a circle through a wall —
/// the engine writes the origin and traces nothing (<see cref="IGameWorld.Teleport"/>) —
/// which is exactly why a path that has to <i>look</i> like a match cannot be generated
/// and has to be recorded from one.</para>
/// </summary>
public sealed class PuppetWalk
{
    /// <summary>A CS player's run, in engine units a second: the speed a path has to hold to look like one.</summary>
    public const double RunUnitsPerSecond = 250;

    /// <summary>Wide enough that a 10 Hz sample is a chord and not a full lap, small enough to stay in one room.</summary>
    public const double DefaultRadiusUnits = 128;

    /// <summary>Long enough for two hundred samples of a puppet at the stream's 100 ms.</summary>
    public const double DefaultSeconds = 20;

    /// <summary>What a walk may be asked for: a minute is already ten times what measuring one needs.</summary>
    public const double MaxSeconds = 60;

    private readonly IGameWorld _world;
    private readonly ILinkLog? _log;
    private readonly List<Walker> _walkers = [];
    private double _radius = DefaultRadiusUnits;
    private double _speed = RunUnitsPerSecond;
    private long _untilMs;
    private int _frames;
    private int _teleports;
    private int _restarts;

    public PuppetWalk(IGameWorld world, ILinkLog? log = null)
    {
        _world = world;
        _log = log;
    }

    /// <summary>Whether a walk is running right now.</summary>
    public bool Walking { get; private set; }

    /// <summary>How many bodies this walk moves.</summary>
    public int Bodies => _walkers.Count;

    /// <summary>Teleports commanded by the walk so far — one per body per frame.</summary>
    public int Teleports => _teleports;

    /// <summary>Frames the walk has driven.</summary>
    public int Frames => _frames;

    /// <summary>Bodies that died and took a new centre where the engine respawned them.</summary>
    public int Restarts => _restarts;

    /// <summary>Whether a walk started, and the line an operator reads.</summary>
    public sealed record Outcome(bool Started, string Message);

    /// <summary>
    /// Walk every puppet on the server for <paramref name="seconds"/> of the world's own
    /// clock. That clock is a stopwatch and not the game's
    /// (<c>GameThreadClock</c>), so a walk is that many <i>real</i> seconds however fast
    /// a simulated match's time scale is running the engine — and so is
    /// <paramref name="speed"/>, which is why a lane that speeds the engine up asks for a
    /// proportionally faster walk if it wants to be comparable to the bodies beside it.
    /// </summary>
    public Outcome Start(double seconds = DefaultSeconds, double speed = RunUnitsPerSecond, double radius = DefaultRadiusUnits)
    {
        if (!(seconds > 0) || seconds > MaxSeconds)
        {
            return new Outcome(false, $"walk: seconds must be above 0 and at most {MaxSeconds}");
        }

        if (!(speed > 0) || !(radius > 0))
        {
            return new Outcome(false, "walk: speed and radius must both be above 0");
        }

        Stop();
        foreach (var player in _world.Players)
        {
            // Every puppet, dead ones included: one that is waiting to respawn takes its
            // circle where the engine puts it back, like any other body that dies during
            // the walk. A window in which some of the room is walked and the rest is the
            // engine's would measure both at once and say nothing about either.
            if (player.IsPuppet)
            {
                _walkers.Add(new Walker(player.SteamId64, player.Position ?? Vector3.Zero, _world.Clock.NowMs)
                {
                    Alive = player.IsAlive && player.Position is not null,
                });
            }
        }

        if (_walkers.Count == 0)
        {
            return new Outcome(false, "walk: nobody to walk — no puppet is on this server");
        }

        _radius = radius;
        _speed = speed;
        _untilMs = _world.Clock.NowMs + (long)Math.Round(seconds * 1000);
        _frames = 0;
        _teleports = 0;
        _restarts = 0;
        Walking = true;
        _world.Tick += OnFrame;
        var line = string.Create(
            CultureInfo.InvariantCulture,
            $"walk: {_walkers.Count} puppet(s) on a circle of {radius:0.#} units at {speed:0.#} units/s for {seconds:0.#} s");
        _log?.Info(line);
        return new Outcome(true, line);
    }

    /// <summary>End the walk where it stands. The bodies are the engine's again from the next frame.</summary>
    public void Stop()
    {
        if (Walking)
        {
            _world.Tick -= OnFrame;
            Walking = false;
            _log?.Info(string.Create(
                CultureInfo.InvariantCulture,
                $"walk: done — {_teleports} teleport(s) over {_frames} frame(s) for {_walkers.Count} body(s), {_restarts} respawn(s)"));
        }

        _walkers.Clear();
    }

    private void OnFrame()
    {
        var now = _world.Clock.NowMs;
        if (now >= _untilMs)
        {
            Stop();
            return;
        }

        _frames++;
        foreach (var walker in _walkers)
        {
            if (_world.Find(walker.SteamId64) is not { } player)
            {
                walker.Alive = false;
                continue;
            }

            if (!player.IsAlive)
            {
                walker.Alive = false;
                continue;
            }

            if (!walker.Alive)
            {
                // Back from a respawn, somewhere else entirely: a new circle from where
                // the engine put the body, so the only jump in the path is the death's.
                walker.Centre = player.Position ?? walker.Centre;
                walker.SinceMs = now;
                walker.Alive = true;
                _restarts++;
            }

            var angle = _speed * ((now - walker.SinceMs) / 1000.0) / _radius;
            var position = new Vector3(
                walker.Centre.X + (float)(_radius * Math.Cos(angle)),
                walker.Centre.Y + (float)(_radius * Math.Sin(angle)),
                walker.Centre.Z);
            // Facing along the path, which is where a person running a corner looks, and
            // standing still in the engine's own reckoning so nothing is added to ours.
            var yaw = (float)((angle * 180 / Math.PI + 90) % 360);
            _world.Teleport(player, position, new Vector3(0, yaw, 0), Vector3.Zero);
            walker.Teleports++;
            _teleports++;
        }
    }

    private sealed class Walker(ulong steamId64, Vector3 centre, long sinceMs)
    {
        public ulong SteamId64 { get; } = steamId64;
        public Vector3 Centre { get; set; } = centre;
        /// <summary>When this body's current circle began — its own clock, because a respawn restarts it.</summary>
        public long SinceMs { get; set; } = sinceMs;
        public bool Alive { get; set; } = true;
        public int Teleports { get; set; }
    }
}
