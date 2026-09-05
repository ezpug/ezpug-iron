Fetch the complete documentation index at: https://dathost.readme.io/llms.txt. Use this file to discover all available pages before exploring further. Append .md to any documentation page URL to get its markdown version.

# API: Added CS2 Workshop Support

**Changelog:**

* Added support for CS2 Workshop:
  * Settings are available in the API ([POST /api/0.1/game-servers](https://dathost.net/reference/post_game_servers) and [PUT /api/0.1/game-servers/\{server\_id}](https://dathost.net/reference/put_game_server_item)) as well as in the UI.
  * Set `cs2_settings.maps_source` to `workshop_single_map` to run the server with a Workshop map.
    * Set `cs2_settings.workshop_single_map_id` to define the Workshop Map when opting for `workshop_single_map` as the map source.

<p>&nbsp;</p>

**Details:**

Valve rolled out an update on November 3rd, 2023, introducing support for community workshop maps. These maps can now be used on CS2 servers hosted by DatHost.

When a workshop map is specified, the server will initially boot on de\_dust2 during the time it takes to download the selected map from Steam's CDN. As soon as the download is complete, the server automatically switches to the specified map. For individual maps, this download typically only takes a few seconds.

Downloaded maps are stored in the `maps/workshop` folder on the server. For future server boots, the map will be launched directly from the local storage.

With each server boot, an automatic check is performed to determine if the workshop map has received any updates. If there is an updated version available, it's downloaded and applied before the map is launched.

To find the Workshop Map ID, you can either use the Steam API or simply check the last sequence of digits in the URL when viewing a particular collection or map on Steam.

<p>&nbsp;</p>

**What about Workshop Collections?**

We haven't found a way to start a server with a workshop collection just yet. The issue seems to be that it isn't possible to define a starting map for the collection, and the server won't default to the first in the collection, so the server is stuck on the regular map used until manually switched in the console.

We'll continue looking into this issue on our end. In the meantime, feel free to test things out yourself with the following server console commands:

`host_workshop_collection <id>` : Download a collection of Workshop maps

`ds_workshop_listmaps` : List all workshop maps available on the server

`ds_workshop_changelevel` : Change the map to an available workshop map by name

<p>&nbsp;</p>