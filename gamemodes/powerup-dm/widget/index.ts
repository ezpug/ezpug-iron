import { defineWidget } from '@ezpug/gamemode-kit'
import Widget from './Widget.vue'

/**
 * The `powerup-dm` widget's entry (decision 17): the component as the
 * `<ezpug-widget>` custom element, mounted and handshaken by the kit when
 * this bundle runs inside the document the orchestrator serves.
 *
 * PRD-02 T25 ships the kit's generic board — every declared verb as a
 * button, its charges and cooldown as the orchestrator last said them, the
 * answer to each tap in the player's language. T26 gives the mode its own
 * face: three power-ups, cooldown rings, the radar peek.
 */
export default defineWidget(Widget)
