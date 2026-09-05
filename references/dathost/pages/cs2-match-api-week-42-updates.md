Fetch the complete documentation index at: https://dathost.readme.io/llms.txt. Use this file to discover all available pages before exploring further. Append .md to any documentation page URL to get its markdown version.

# CS2 Match-API: Week 42 Updates

**Changelog:**

* Players who disconnect during halftime and then reconnect will now have their money reset to mp\_startmoney.
* Reconnecting players will now automatically be assigned to their correct teams.
* Fixed an issue where the match would not start even if all players had connected.
* Temporarily disabled bots on the server when starting a new match due to an entity reservation issue.
* Team names now display correctly in the HUD for players and GOTV viewers.

<p>&nbsp;</p>

**Detailed information:**

A previously known bug that failed to reset players' money correctly upon reconnecting during halftime periods has now been fixed. Player reconnections are now handled properly by reserving the entire state, including which team they were playing on, their money, statistics, etc.

Additionally, we have resolved an issue that prevented matches from starting even when all 10 players were connected. This was due to a backend processing error that failed to handle logs correctly during player reconnections.

We have also temporarily force-activated the "Disable bots" option on all servers when starting a new match. This serves as a temporary workaround for a server binary issue that could cause players to become stuck and unable to join their team due to entity reservation problems. Valve has been notified, and we expect to see a fix fairly soon.

<p>&nbsp;</p>

**Moving forward:**

With the recent improvements, our CS2 Match-API is inching closer to its stable iteration. We'll soon provide an overview of upcoming features, such as knife rounds and more. Our primary objective has been system stability in the weeks after release, but we're gearing up to introduce more features shortly! 🚀