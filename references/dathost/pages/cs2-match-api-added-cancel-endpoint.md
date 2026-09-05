Fetch the complete documentation index at: https://dathost.readme.io/llms.txt. Use this file to discover all available pages before exploring further. Append .md to any documentation page URL to get its markdown version.

# CS2 Match-API: Added Cancel Endpoint

Today, we're rolling out a new feature to facilitate the force-cancellation of matches. When you cancel a live match, the following actions will be taken:

1. All players will be kicked from the server
2. The match will be marked as finished, with the cancel\_reason: `USER_API_CANCEL`
3. A `webhooks.match_end_url`  will be sent to your specified URL.

Check out the endpoint here: <https://dathost.net/reference/post_api-0-1-cs2-matches-match-id-cancel>