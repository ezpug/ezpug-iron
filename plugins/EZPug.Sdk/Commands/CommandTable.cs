using System.Text.Json.Nodes;
using EZPug.Sdk.Protocol;

namespace EZPug.Sdk;

/// <summary>What the SDK decided about one tap before (or after) the mode saw it.</summary>
public sealed record CommandVerdict(
    LinkCommandStatus Status,
    PlayerCommandRefusal? Code,
    /// <summary>In the player's language; the phone shows it as it is.</summary>
    string? Message,
    /// <summary>For <c>cooldown</c>: how long until the verb works again. After an applied tap: the cooldown just started, when there is one.</summary>
    long? CooldownMs,
    /// <summary>Charges left in the current period, where the verb has charges.</summary>
    long? ChargesLeft)
{
    public bool Applied => Status == LinkCommandStatus.Applied;

    public static CommandVerdict Ok(long? cooldownMs, long? chargesLeft) =>
        new(LinkCommandStatus.Applied, null, null, cooldownMs, chargesLeft);

    public static CommandVerdict Refuse(PlayerCommandRefusal code, string message, long? cooldownMs = null, long? chargesLeft = null) =>
        new(LinkCommandStatus.Rejected, code, message, cooldownMs, chargesLeft);
}

/// <summary>What a mode answers <c>OnPlayerCommand</c> with: it did the thing, or it will not.</summary>
public abstract record PlayerCommandOutcome
{
    public sealed record Applied : PlayerCommandOutcome;

    /// <summary><paramref name="Message"/> is already in the player's language — use the mode's <c>Lines(player)</c>.</summary>
    public sealed record Refused(string Message) : PlayerCommandOutcome;

    /// <summary>The verb needs a living player and this one is dead.</summary>
    public sealed record NotAlive : PlayerCommandOutcome;

    public static readonly PlayerCommandOutcome Ok = new Applied();
}

/// <summary>
/// <b>The player commands a manifest declares, enforced here and never trusted to the
/// phone</b> (decision 17, docs/gamemodes.md "Player commands"). Per player and verb:
/// the cooldown as a deadline on the clock, the charges as a count that refills when
/// its period turns — <c>life</c> on spawn, <c>round</c> on round start, <c>map</c> on
/// map start, <c>match</c> never. A tap is checked in the order the refusal set lists:
/// the verb exists, the args fit, the cooldown has passed, a charge is left; only then
/// does the mode see it, and only an applied outcome spends the charge and starts the
/// cooldown. Messages come from the <see cref="Localizer"/> in the player's locale.
/// </summary>
public sealed class CommandTable
{
    private readonly IClock _clock;
    private readonly Localizer _localizer;
    private readonly Dictionary<string, PlayerCommandSpec> _specs = new(StringComparer.Ordinal);
    private readonly Dictionary<(ulong SteamId64, string Command), Usage> _usage = new();

    private sealed class Usage
    {
        public long CooldownUntilMs;
        public long Used;
    }

    public CommandTable(IEnumerable<PlayerCommandSpec> specs, IClock clock, Localizer localizer)
    {
        _clock = clock;
        _localizer = localizer;
        foreach (var spec in specs)
        {
            _specs[spec.Name] = spec;
        }
    }

    public IReadOnlyCollection<PlayerCommandSpec> Specs => _specs.Values;

    public bool Declares(string command) => _specs.ContainsKey(command);

    /// <summary>The checks before the mode sees the tap. <c>null</c> means "ask the mode".</summary>
    public CommandVerdict? Precheck(ulong steamId64, Locale locale, string command, JsonObject? args)
    {
        var lines = _localizer.For(locale);
        if (!_specs.TryGetValue(command, out var spec))
        {
            return CommandVerdict.Refuse(PlayerCommandRefusal.UnknownCommand, lines["command.unknown_command"]);
        }

        var problem = ArgsValidator.Validate(spec.Args, args);
        if (problem is not null)
        {
            return CommandVerdict.Refuse(PlayerCommandRefusal.InvalidArgs, lines["command.invalid_args", problem]);
        }

        var usage = UsageOf(steamId64, command);
        var now = _clock.NowMs;
        if (usage.CooldownUntilMs > now)
        {
            var left = usage.CooldownUntilMs - now;
            return CommandVerdict.Refuse(
                PlayerCommandRefusal.Cooldown,
                lines["command.cooldown", (long)Math.Ceiling(left / 1000.0)],
                cooldownMs: left,
                chargesLeft: ChargesLeft(spec, usage));
        }

        if (spec.Charges is { } charges && usage.Used >= charges.Count)
        {
            return CommandVerdict.Refuse(
                PlayerCommandRefusal.NoCharges,
                lines["command.no_charges", lines[$"period.{PeriodName(charges.Per)}"]],
                chargesLeft: 0);
        }

        return null;
    }

    /// <summary>The mode said yes: spend the charge, start the cooldown, say what is left.</summary>
    public CommandVerdict Spend(ulong steamId64, string command)
    {
        var spec = _specs[command];
        var usage = UsageOf(steamId64, command);
        usage.Used++;
        if (spec.CooldownMs > 0)
        {
            usage.CooldownUntilMs = _clock.NowMs + spec.CooldownMs;
        }

        return CommandVerdict.Ok(spec.CooldownMs > 0 ? spec.CooldownMs : null, ChargesLeft(spec, usage));
    }

    /// <summary>The mode said no, in its own words.</summary>
    public CommandVerdict Refused(ulong steamId64, Locale locale, string command, PlayerCommandOutcome outcome)
    {
        var lines = _localizer.For(locale);
        var spec = _specs[command];
        var chargesLeft = ChargesLeft(spec, UsageOf(steamId64, command));
        return outcome switch
        {
            PlayerCommandOutcome.NotAlive => CommandVerdict.Refuse(PlayerCommandRefusal.NotAlive, lines["command.not_alive"], chargesLeft: chargesLeft),
            PlayerCommandOutcome.Refused refused => CommandVerdict.Refuse(PlayerCommandRefusal.Refused, refused.Message, chargesLeft: chargesLeft),
            _ => throw new ArgumentException($"{outcome.GetType().Name} is not a refusal", nameof(outcome)),
        };
    }

    /// <summary>A period turned for one player (<c>life</c> on spawn) or everybody (<c>round</c>, <c>map</c>): refill the charges counted against it.</summary>
    public void Reset(PlayerCommandChargePeriod period, ulong? steamId64 = null)
    {
        foreach (var ((who, command), usage) in _usage)
        {
            if (steamId64 is not null && who != steamId64)
            {
                continue;
            }

            if (_specs.TryGetValue(command, out var spec) && spec.Charges?.Per == period)
            {
                usage.Used = 0;
            }
        }
    }

    /// <summary>The player left or the match ended: forget them.</summary>
    public void Forget(ulong steamId64)
    {
        foreach (var key in _usage.Keys.Where(key => key.SteamId64 == steamId64).ToList())
        {
            _usage.Remove(key);
        }
    }

    public void Clear() => _usage.Clear();

    /// <summary>What the widget's <c>hello</c> shows: the verb's state for one player (PRD-02 T24).</summary>
    public (long CooldownLeftMs, long? ChargesLeft) StateOf(ulong steamId64, string command)
    {
        var spec = _specs[command];
        var usage = UsageOf(steamId64, command);
        return (Math.Max(0, usage.CooldownUntilMs - _clock.NowMs), ChargesLeft(spec, usage));
    }

    private Usage UsageOf(ulong steamId64, string command)
    {
        if (!_usage.TryGetValue((steamId64, command), out var usage))
        {
            usage = new Usage();
            _usage[(steamId64, command)] = usage;
        }

        return usage;
    }

    private static long? ChargesLeft(PlayerCommandSpec spec, Usage usage) =>
        spec.Charges is { } charges ? Math.Max(0, charges.Count - usage.Used) : null;

    private static string PeriodName(PlayerCommandChargePeriod period) =>
        period switch
        {
            PlayerCommandChargePeriod.Life => "life",
            PlayerCommandChargePeriod.Round => "round",
            PlayerCommandChargePeriod.Map => "map",
            _ => "match",
        };
}
