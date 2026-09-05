Fetch the complete documentation index at: https://dathost.readme.io/llms.txt. Use this file to discover all available pages before exploring further. Append .md to any documentation page URL to get its markdown version.

# CS2 Match-API: Tech/Tac Pauses and Custom Nicknames

**Changelog:**

* Added a new setting: `settings.enable_tech_pause` *(default: false)*
* Added a new player parameter: `players.nickname_override`
* Added chat command: `!tac` for tactical pauses

<p>&nbsp;</p>

**Details:**

Tech pause is an honor system, allowing any player to initiate an indefinite pause at the next freezetime by typing `!tech`. To resume the game, one player from each team needs to type `!unpause`. There is no adjustability for duration and/or voting requirements.

There is a new parameter available in the player object: `players.nickname_override`. This allows you to set a custom nickname for each player, overriding their Steam names. If left blank, the player's Steam name is used by default.

With the addition of `!tech`, we've added another chat command: `!tac`. This command provides an alternative method to trigger a tactical timeout, though the commands for duration and length remain the same. To disable tactical timeouts, add `mp_team_timeout_max 0` to your server config. Read more here on all tactical timeout configurations: [Custom Configs - Tactical Timeout Settings](https://dathost.net/docs/cs2-tactical-timeout-settings)

<p>&nbsp;</p>

Check out all these new options in the API reference here: [POST /api/0.1/cs2-matches](https://dathost.net/reference/post_api-0-1-cs2-matches)