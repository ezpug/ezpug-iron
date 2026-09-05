Fetch the complete documentation index at: https://dathost.readme.io/llms.txt. Use this file to discover all available pages before exploring further. Append .md to any documentation page URL to get its markdown version.

# CS2 Match-API Update: Team Locks via SteamID

**Changelog:**

* Added a new experimental setting: `settings.enable_plugin` *(default: false)*

<p>&nbsp;</p>

**Details:**

We have developed a new proprietary match plugin based on [CounterStrikeSharp](https://github.com/roflmuffin/CounterStrikeSharp), designed to assign players directly to their correct teams, bypassing the current method that relies on backup files.

The existing backup method has several limitations that could not be resolved natively without the creation of a third-party plugin:

1. Players end up on the wrong team in rare edge cases.
2. Confusion for new users who may initially find themselves on the "wrong" team.
3. Duplicate teammate colors on the radar due to engine limitations.
4. Issues with reconnecting correctly from a new IP address.

To address these issues, we've introduced a new flow that can be activated by setting the `settings.enable_plugin` to `true`. This will activate our plugin, along with [MetaMod](https://github.com/alliedmodders/metamod-source) and [CounterStrikeSharp](https://github.com/roflmuffin/CounterStrikeSharp), to ensure players are placed on the correct team from the start, resolving the four aforementioned issues.

Please note that since our plugin depends on MetaMod and CounterStrikeSharp, it may be affected by future Counter-Strike updates, requiring us to wait for updates from them. However, we remain fully backward-compatible with our previous solution, allowing you to simply toggle the flag back to false if necessary.

While we believe this new solution offers a superior user experience, it is still considered experimental, as there may be bugs that we haven't yet identified. If you encounter any issues, please reach out to us at <support@dathost.net>.