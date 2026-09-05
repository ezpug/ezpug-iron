using System.Reflection;
using System.Xml.Linq;

namespace EZPug.Sdk;

/// <summary>
/// One language's lines, read from a resx document (<c>&lt;data name="…"&gt;&lt;value&gt;…</c>)
/// embedded as raw XML. The resx format so an editor's tooling works; our own reader so
/// no satellite assembly has to be found beside the plugin (the csproj says why).
/// </summary>
public sealed class ResxCatalog
{
    private readonly Dictionary<string, string> _lines;

    public ResxCatalog(IReadOnlyDictionary<string, string> lines)
    {
        _lines = new Dictionary<string, string>(lines, StringComparer.Ordinal);
    }

    public int Count => _lines.Count;

    public bool TryGet(string key, out string value) => _lines.TryGetValue(key, out value!);

    public IEnumerable<string> Keys => _lines.Keys;

    public static ResxCatalog Parse(Stream stream)
    {
        var document = XDocument.Load(stream);
        var lines = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var data in document.Root?.Elements("data") ?? [])
        {
            var name = data.Attribute("name")?.Value;
            var value = data.Element("value")?.Value;
            if (name is null || value is null)
            {
                continue;
            }

            lines[name] = value;
        }

        return new ResxCatalog(lines);
    }

    /// <summary>Read <paramref name="logicalName"/> from <paramref name="assembly"/>'s embedded resources.</summary>
    public static ResxCatalog FromEmbedded(Assembly assembly, string logicalName)
    {
        using var stream = assembly.GetManifestResourceStream(logicalName)
            ?? throw new InvalidOperationException(
                $"{assembly.GetName().Name} embeds no resource named {logicalName}; it has: {string.Join(", ", assembly.GetManifestResourceNames())}");
        return Parse(stream);
    }
}
