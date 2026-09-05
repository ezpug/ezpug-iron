---
updatedAt: 2026-04-07T16:06:53.000Z
---

Fetch the complete documentation index at: https://dathost.readme.io/llms.txt. Use this file to discover all available pages before exploring further. Append .md to any documentation page URL to get its markdown version.

# Introduction

## Initiate match

To initiate a match, you would send a POST request to the following endpoint:

[POST /api/0.1/cs2-matches](https://dathost.net/reference/post_api-0-1-cs2-matches)

The body of your request should be structured as a JSON object, containing the necessary details to initialize a match. Here's an example body request:

```json
{
    "game_server_id": "6503b7832e1d23f8c5c6f762",
    "players": [
        {
            "steam_id_64": "76561198234907126",
            "team": "team1",
            "nickname_override": "Player One"
        },
        {
            "steam_id_64": "76561239480715690",
            "team": "team2",
            "nickname_override": "Player Two"
        }
    ],
    "team1": {
        "name": "Ninjas in Pyjamas",
        "flag": "SE"
    },
    "team2": {
        "name": "Astralis",
        "flag": "DK"
    },
    "settings": {
        "map": "de_mirage",
        "password": null,
        "connect_time": 300,
        "match_begin_countdown": 30,
        "team_size": null,
      	"wait_for_gotv": false,
      	"enable_plugin": true,
      	"enable_tech_pause": true
    },
    "webhooks": {
        "match_end_url": "https://webhook.site/123",
        "round_end_url": "https://webhook.site/124",
        "player_votekick_success_url": "https://webhook.site/125",
        "authorization_header": ""
    }
}
```

## Retrieve match information

During the match, we're sending updates to webhooks at certain events: After every round, match-end, and when someone gets kicked.

Your other option is to poll the API for live data using the following endpoint:

[GET /api/0.1/cs2-matches/\{match\_id}](https://dathost.net/reference/get_api-0-1-cs2-matches-match-id)

With the GET endpoint, you get up-to-date information on the entire match, including players connected, players kicked, team and player stats, and more. The information included in this endpoint is the same as being sent to the round\_end and match\_end webhook.

<p> </p>

## Changing players mid-game

In case of an emergency situation where you need to whitelist a new player during the game, we have a special endpoint to add new players:

[POST /api/0.1/cs2-matches/\{match\_id}/players](https://dathost.net/reference/post_api-0-1-cs2-matches-match-id-players)

This endpoint accepts a JSON object containing a SteamID64, together with which team the player belongs to (team1, team2, or spectator).

<p> </p>

## Supported game modes

Our CS2 Match API is mainly built for standard 5v5 competitive matches. While other game modes might function, they are not officially supported and could lead to unexpected issues.

A few important considerations:

* Halftime must remain enabled; otherwise, score parsing will not work correctly.
* `mp_maxrounds` should be set to an even number to avoid problems with halftime side switching (example: `24`).
* The API is designed around round-based gameplay. Modes like deathmatch, which do not follow a round structure, are difficult to support and may require hacky workarounds.

That said, smaller formats such as 2v2 or 1v1 will work as long as they adhere to the same structural rules the API expects.

Our support team is happy to help with questions, but keep in mind that configurations outside standard 5v5 competitive play are not officially supported, and some issues may not have viable solutions.

<p> </p>

## Custom configs

The idea with our Match-API is to not interfere with the game's default settings and what's configured on the server already. For more advanced customizations of some features, check out our guides below:

#### Configure Tactical Pauses

By default, each team has access to 1 timeout of 60 seconds per match. Read more here on how to customize this: [CS2 Match-API: Tactical Timeout Settings](https://dathost.net/docs/cs2-tactical-timeout-settings)

#### Configure Votekicking Behavior

By default, vote-kicking is enabled on the server. Read more here on how to customize the vote-kick flow: [CS2 Match-API: Votekick Settings](https://dathost.net/docs/cs2-votekick-settings)

#### Configure Overtime

By default, overtime is enabled on the server. Read more here on how to customize the overtime flow: [CS2 Match-API: Overtime Settings](https://dathost.net/docs/cs2-overtime-settings)