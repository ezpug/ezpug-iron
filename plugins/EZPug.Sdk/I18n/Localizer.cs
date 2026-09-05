using System.Globalization;
using System.Reflection;
using EZPug.Sdk.Protocol;

namespace EZPug.Sdk;

/// <summary>
/// <b>Bilingual where a human reads it</b> (CLAUDE.md): every line a mode prints comes
/// through here, in the player's locale from their roster profile, German when nobody
/// said otherwise. Keys are looked up in the gamemode's catalog first, then the SDK's;
/// a key nobody has is returned as <c>[key]</c> so a missing line is visible in the game
/// rather than an exception in a hook. Format arguments are <see cref="string.Format(IFormatProvider, string, object[])"/>'s,
/// numbers formatted for the locale.
/// </summary>
public sealed class Localizer
{
    private static readonly Dictionary<Locale, ResxCatalog> SdkLines = new()
    {
        [Locale.De] = ResxCatalog.FromEmbedded(typeof(Localizer).Assembly, "EZPug.Sdk.I18n.Lines.de.resx"),
        [Locale.En] = ResxCatalog.FromEmbedded(typeof(Localizer).Assembly, "EZPug.Sdk.I18n.Lines.en.resx"),
    };

    private readonly IReadOnlyDictionary<Locale, ResxCatalog> _mode;

    /// <summary>The SDK's lines only.</summary>
    public Localizer() : this(new Dictionary<Locale, ResxCatalog>()) { }

    /// <summary>The SDK's lines under a gamemode's own catalogs.</summary>
    public Localizer(IReadOnlyDictionary<Locale, ResxCatalog> modeCatalogs)
    {
        _mode = modeCatalogs;
    }

    /// <summary>
    /// A gamemode's catalogs from its own embedded resx pair: <c>{prefix}.de.resx</c> and
    /// <c>{prefix}.en.resx</c>, both required — a mode that speaks one language is not
    /// finished (docs/sdk.md).
    /// </summary>
    public static Localizer FromEmbedded(Assembly assembly, string logicalPrefix) =>
        new(new Dictionary<Locale, ResxCatalog>
        {
            [Locale.De] = ResxCatalog.FromEmbedded(assembly, $"{logicalPrefix}.de.resx"),
            [Locale.En] = ResxCatalog.FromEmbedded(assembly, $"{logicalPrefix}.en.resx"),
        });

    /// <summary>The default when a player's profile says nothing: German.</summary>
    public const Locale DefaultLocale = Locale.De;

    public static CultureInfo CultureOf(Locale locale) =>
        locale == Locale.En ? CultureInfo.GetCultureInfo("en-GB") : CultureInfo.GetCultureInfo("de-DE");

    /// <summary>Does either catalog know <paramref name="key"/> in <paramref name="locale"/>?</summary>
    public bool Has(Locale locale, string key) =>
        (_mode.TryGetValue(locale, out var mode) && mode.TryGet(key, out _))
        || SdkLines[locale].TryGet(key, out _);

    /// <summary>The line for <paramref name="key"/> in <paramref name="locale"/>, formatted.</summary>
    public string Get(Locale locale, string key, params object[] args)
    {
        string? template = null;
        if (_mode.TryGetValue(locale, out var mode) && mode.TryGet(key, out var fromMode))
        {
            template = fromMode;
        }
        else if (SdkLines[locale].TryGet(key, out var fromSdk))
        {
            template = fromSdk;
        }

        if (template is null)
        {
            return $"[{key}]";
        }

        return args.Length == 0 ? template : string.Format(CultureOf(locale), template, args);
    }

    /// <summary>A view fixed to one locale — what a mode hands a per-player print.</summary>
    public LocalizedLines For(Locale locale) => new(this, locale);
}

/// <summary>The lines in one locale: <c>lines["key", arg]</c>.</summary>
public sealed class LocalizedLines
{
    private readonly Localizer _localizer;

    public LocalizedLines(Localizer localizer, Locale locale)
    {
        _localizer = localizer;
        Locale = locale;
    }

    public Locale Locale { get; }

    public string this[string key, params object[] args] => _localizer.Get(Locale, key, args);
}
