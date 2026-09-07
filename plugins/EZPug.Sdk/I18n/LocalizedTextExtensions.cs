using EZPug.Sdk.Protocol;

namespace EZPug.Sdk;

/// <summary>
/// Reading the bilingual text the wire carries — a manifest's title and description, a
/// player command's title — in one player's language. Both languages are always there
/// (the schema refuses a manifest that speaks one), so this never falls back to the other.
/// </summary>
public static class LocalizedTextExtensions
{
    public static string In(this LocalizedText text, Locale locale) => locale == Locale.En ? text.En : text.De;
}
