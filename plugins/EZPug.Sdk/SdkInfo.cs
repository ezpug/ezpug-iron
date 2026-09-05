using System.Reflection;

namespace EZPug.Sdk;

/// <summary>
/// What this build of the SDK was made against. The number itself is stated once,
/// in <c>plugins/Directory.Build.props</c>, and reaches this assembly as metadata;
/// no source file repeats it.
/// </summary>
public static class SdkInfo
{
    /// <summary>The SDK's own version (the csproj's <c>Version</c>), what a server reports as <c>versions.sdk</c> in its hello.</summary>
    public static string Version =>
        (typeof(SdkInfo).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
            ?? typeof(SdkInfo).Assembly.GetName().Version?.ToString(3)
            ?? "0.0.0").Split('+', 2)[0];

    /// <summary>The CounterStrikeSharp.API package version the SDK compiles against.</summary>
    public static string CounterStrikeSharpApiVersion =>
        typeof(SdkInfo).Assembly
            .GetCustomAttributes<AssemblyMetadataAttribute>()
            .Single(attribute => attribute.Key == "CounterStrikeSharp.API")
            .Value ?? throw new InvalidOperationException("CounterStrikeSharp.API metadata is missing");
}
