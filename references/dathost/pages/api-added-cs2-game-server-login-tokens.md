Fetch the complete documentation index at: https://dathost.readme.io/llms.txt. Use this file to discover all available pages before exploring further. Append .md to any documentation page URL to get its markdown version.

# API: Added CS2 Game Server Login Tokens

**Changelog:**

* Added new parameter: `cs2_settings.steam_game_server_login_token`

**Details:**

Valve introduced support for "Game Server Login Tokens" (GSLT) in their unannounced update `Oct 26 15:13:77`.

Currently, a GSLT is only required to make your server appear in the server browser. However, starting a server without specifying a token will result in the following error message being printed in the console:

```Text gslt_error
****************************************************
*                                                  *
*  No Steam account token was specified.           *
*  Logging into anonymous game server account.     *
*  Connections will be restricted to LAN only.     *
*                                                  *
*  To create a game server account go to           *
*  http://steamcommunity.com/dev/managegameservers *
*                                                  *
****************************************************
```

Drawing parallels from CS:GO, we expect that Valve will soon enforce the presence of this token for CS2 as well. While immediate action isn't necessary, please be aware that **Valve is likely to enforce this requirement strictly**. Consequently, servers might not be open for online connections without the specified token when that happens.

To create a token, you have two options:

1. Manually through the website: <https://steamcommunity.com/dev/managegameservers>
2. Programmatically through the Steam API: <https://partner.steamgames.com/doc/webapi/IGameServersService#CreateAccount>

The App-ID for CS2 is 730.