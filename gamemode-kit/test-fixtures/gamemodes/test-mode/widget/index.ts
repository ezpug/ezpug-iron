// The kit imported by path: this fixture sits inside the kit, where the
// package cannot resolve itself. A real gamemode imports '@ezpug/gamemode-kit'.
import { defineWidget } from '../../../../src/index'
import Widget from './Widget.vue'

export default defineWidget(Widget)
