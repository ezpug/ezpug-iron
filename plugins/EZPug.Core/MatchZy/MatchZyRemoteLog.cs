using EZPug.Sdk;
using EZPug.Sdk.Protocol;

namespace EZPug.Core;

/// <summary>
/// <b>Where MatchZy's remote log points</b> (decision 19, PRD-02 T9). MatchZy 0.8.15 has no
/// in-process forwards: every match-flow fact it knows leaves it as one HTTP POST to
/// <c>matchzy_remote_log_url</c>, with one custom header. The core plugin points that at
/// the orchestrator's MatchZy door and puts this server's own link token in the header,
/// both from the sidecar it already dialled the link with — so the orchestrator holds one
/// secret per server, hashed, and attributes a MatchZy event to the same ledger row as
/// an event over the link.
///
/// The three are set as console commands <i>after</i> <c>matchzy_loadmatch</c>, never
/// inside the match config: <c>matchzy_loadmatch</c> replaces MatchZy's config object
/// (and would drop values set before it), and a config carrying the token would be
/// serialised into every round backup MatchZy writes (<c>GetMatchConfig()</c>) — the
/// remote-log <i>header value</i> still lands there, which is why
/// <see cref="MatchZyBackups.Scrub"/> exists. <see cref="ToString"/> redacts.
/// </summary>
public sealed record MatchZyRemoteLog(Uri Url, string HeaderKey, string HeaderValue)
{
    public static MatchZyRemoteLog From(Sidecar sidecar) =>
        new(sidecar.HttpUrl(ProtocolConstants.MatchzyLogPath), ProtocolConstants.MatchzyTokenHeader, sidecar.Token);

    /// <summary>The console lines that point MatchZy here, in order. The last one carries the token.</summary>
    public IReadOnlyList<string> Commands() =>
    [
        $"matchzy_remote_log_url {Url}",
        $"matchzy_remote_log_header_key {HeaderKey}",
        $"matchzy_remote_log_header_value {HeaderValue}",
    ];

    public override string ToString() => $"MatchZyRemoteLog {{ Url = {Url}, Header = {HeaderKey}: [redacted] }}";
}
