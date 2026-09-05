Fetch the complete documentation index at: https://dathost.readme.io/llms.txt. Use this file to discover all available pages before exploring further. Append .md to any documentation page URL to get its markdown version.

# CS2 Match-API: Added Workshop Support

**Changelog:**

* Added support for workshop maps in the `settings.map` parameter

<p>&nbsp;</p>

**Details:**

Following Valve's introduction of workshop support on November 3rd, our CS2 Match-API has been updated to include this feature.

Now, when you make a [Match POST request to /api/0.1/cs2-matches](https://dathost.net/reference/post_api-0-1-cs2-matches), you can specify a workshop map using the `settings.map` parameter. The required format for workshop maps is `workshop/ID`. Here, ID represents the number sequence found in the workshop map's URL on the Steam Community website.

For example, to use the map available at <https://steamcommunity.com/sharedfiles/filedetails/?id=3070244462>, you should input `workshop/3070244462` in the `settings.map` field.