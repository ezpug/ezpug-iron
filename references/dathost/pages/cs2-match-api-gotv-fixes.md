Fetch the complete documentation index at: https://dathost.readme.io/llms.txt. Use this file to discover all available pages before exploring further. Append .md to any documentation page URL to get its markdown version.

# CS2 Match-API: GOTV Fixes

**Changelog:**

* On match post, the server map group is now unset to prevent issues with match end map votes and other related issues.
* Added a `settings.wait_for_gotv` parameter which can delay the stopping of the demo recording.

<p>&nbsp;</p>

**Detailed information:**

When you're broadcasting a match with a `tv_delay`, it's required to delay the stopping of the demo recording to prevent a noticeable "lag" on the server. Stopping a demo triggers the server to flush the entire buffer to disk, a resource-intensive task that lasts a few seconds. This process also has an impact on the GOTV stream.

To address this, you should set the `settings.wait_for_gotv` parameter to `true` for matches in which you have **live GOTV viewers.** For matches where you're not spectating through GOTV, there's no need to enable this feature.

You can find this new parameter in the settings object here: [POST /api/0.1/cs2-matches](https://dathost.net/reference/post_api-0-1-cs2-matches)

**Please note:** The match\_end webhook will continue to be sent 20 seconds after the match ends. For matches where you are using GOTV, you need to consider the `tv_delay` when managing the timing of your actions.