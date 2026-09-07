using CounterStrikeSharp.API.Core;
using System.Text.Json.Serialization;

namespace WeaponPaints
{
	public class Additional
	{
		[JsonPropertyName("KnifeEnabled")]
		public bool KnifeEnabled { get; set; } = true;

		[JsonPropertyName("GloveEnabled")]
		public bool GloveEnabled { get; set; } = true;

		[JsonPropertyName("MusicEnabled")]
		public bool MusicEnabled { get; set; } = true;

		[JsonPropertyName("AgentEnabled")]
		public bool AgentEnabled { get; set; } = true;

		[JsonPropertyName("SkinEnabled")]
		public bool SkinEnabled { get; set; } = true;

		[JsonPropertyName("PinsEnabled")]
		public bool PinsEnabled { get; set; } = true;

		[JsonPropertyName("CommandWpEnabled")]
		public bool CommandWpEnabled { get; set; } = true;

		// EZPug (PATCHES.md): off by default. A suicide command existed upstream so a knife
		// picked from a menu could be re-rendered; there is no menu here, and a competitive
		// server hands nobody a free death. A gamemode that wants it turns it on through
		// its plugin config.
		[JsonPropertyName("CommandKillEnabled")]
		public bool CommandKillEnabled { get; set; } = false;

		[JsonPropertyName("CommandRefresh")]
		public List<string> CommandRefresh { get; set; } = ["wp"];

		[JsonPropertyName("CommandKill")]
		public List<string> CommandKill { get; set; } = ["kill"];

		[JsonPropertyName("GiveRandomKnife")]
		public bool GiveRandomKnife { get; set; } = false;

		[JsonPropertyName("GiveRandomSkin")]
		public bool GiveRandomSkin { get; set; } = false;
	}

	public class WeaponPaintsConfig : BasePluginConfig
	{
        [JsonPropertyName("ConfigVersion")] public override int Version { get; set; } = 10;

        [JsonPropertyName("SkinsLanguage")]
		public string SkinsLanguage { get; set; } = "en";

		[JsonPropertyName("CmdRefreshCooldownSeconds")]
		public int CmdRefreshCooldownSeconds { get; set; } = 3;

		[JsonPropertyName("Additional")]
		public Additional Additional { get; set; } = new();
	}
}
