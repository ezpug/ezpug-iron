/**
 * **The HUD's addon id, on its way to a server** (PRD-07 T2a, `docs/hud.md`).
 *
 * A CS2 server loads MultiAddonManager only when it has a Workshop id
 * (`EZPUG_HUD_ADDON`): the image keeps the plugin's loader file asleep and
 * the entrypoint copies it into `addons/metamod/` when the id is set (T2).
 * The orchestrator has one operator value, `EZPUG_IRON_HUD_ADDON`, unset in
 * production until the owner has looked, and each provider hands it on the
 * way that provider can:
 *
 * - **nodes**: one more variable in the container spec, so the entrypoint
 *   does the rest;
 * - **Dathost**: a clone has no entrypoint, so `configure` uploads the
 *   loader file itself and names the id in `ezpug.json`.
 *
 * Unset, both providers send byte for byte what they sent before the HUD
 * existed.
 */

/** The variable the server image reads (`docker/cs2/entrypoint.sh`). */
export const HUD_ADDON_SERVER_VAR = 'EZPUG_HUD_ADDON'

/** What a Workshop id looks like: the entrypoint's own test, `^[1-9][0-9]{0,19}$`. */
export const WORKSHOP_ID_PATTERN = /^[1-9][0-9]{0,19}$/

/**
 * Where Metamod finds MultiAddonManager's loader file, from the game root a
 * Dathost path starts at. `scripts/dathost-image.mjs` refuses the same path
 * on the template (`ASLEEP_PLUGIN_LOADER`), and a test keeps the two equal.
 */
export const HUD_ADDON_LOADER_PATH = 'addons/metamod/multiaddonmanager.vdf'

/**
 * The loader file as MultiAddonManager 1.6.2's release ships it, byte for
 * byte (`/opt/ezpug/asleep/metamod/multiaddonmanager.vdf` in the CS2 image).
 * It names the binary the template already carries.
 */
export const HUD_ADDON_LOADER =
  '"Metamod Plugin"\n{\n\t"alias"\t"multiaddonmanager"\n\t"file"\t"addons/multiaddonmanager/bin/multiaddonmanager"\n}\n'
