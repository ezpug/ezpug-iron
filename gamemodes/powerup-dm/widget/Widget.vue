<script setup lang="ts">
/**
 * **`powerup-dm`'s phone** (PRD-02 T26, decision 17). Three buttons — the three `kind`
 * values the manifest's `powerup` verb declares, read off the verb's own args schema, so
 * a fourth power-up is a manifest edit and not a widget edit — each with a ring that
 * fills as the one charge this life comes back; and the peek: five seconds of dots the
 * plugin pushes at this phone and nowhere else, drawn where the player is standing.
 *
 * The SDK on the server is the truth about every tap. What is drawn here is the
 * orchestrator's last word (`chargesLeft`, `readyInMs` from the `hello`, refreshed by
 * every `command_result`), which is a hint, and the answer to the tap, which is not.
 */
import {
  KIT_COPY,
  useWidget,
  type WidgetCommandResultFrame,
  type WidgetCommandView,
  type WidgetPushFrame,
} from '@ezpug/gamemode-kit'
import { computed, onScopeDispose, ref } from 'vue'

const { link, locale, t, now, playerToken } = useWidget()

/** The verb the manifest declares; the mode's own name for it, mirrored here so the buttons can find it. */
const VERB = 'powerup'
/** The push the plugin sends while a peek runs. */
const PEEK_PUSH = 'radar_peek'
/**
 * How far around the player the peek reaches, in engine units. A contact further out is
 * drawn on the rim and dimmed: the radar says "that way, far", which is what a radar says.
 * 2000 units is about the long half of Mirage.
 */
const PEEK_RANGE = 2000
/** Above or below this many units the contact is on another floor and is drawn hollow. */
const PEEK_FLOOR = 180

const COPY = {
  title: { de: 'Power-up', en: 'Power-up' },
  hint: {
    de: 'Einmal pro Leben. Tippen, solange du lebst.',
    en: 'Once per life. Tap while you are alive.',
  },
  spent: { de: 'Dieses Leben ist vergeben.', en: 'Spent for this life.' },
  ready: { de: 'bereit', en: 'ready' },
  cooldown: { de: 'in {s} s', en: 'in {s} s' },
  sending: { de: 'wird gesendet …', en: 'sending…' },
  live: { de: 'Match läuft', en: 'Match live' },
  peekTitle: { de: 'Radarblick', en: 'Radar peek' },
  peekLeft: { de: 'noch {s} s', en: '{s} s left' },
  peekAlone: { de: 'niemand in der Nähe', en: 'nobody nearby' },
  peekContacts: { de: '{n} in Sicht', en: '{n} in sight' },
} as const

/** The three kinds, in the manifest's order, each with its own face. */
const KIND_COPY: Record<
  string,
  { label: { de: string; en: string }; note: { de: string; en: string }; glyph: string }
> = {
  speed: {
    label: { de: 'Tempo', en: 'Speed' },
    note: { de: 'schneller bis zum Tod', en: 'faster until you die' },
    glyph: '»',
  },
  armor: {
    label: { de: 'Rüstung', en: 'Armor' },
    note: { de: 'volle Weste', en: 'a full vest' },
    glyph: '▣',
  },
  radar_peek: {
    label: { de: 'Radarblick', en: 'Radar peek' },
    note: { de: '5 s alle Gegner', en: '5 s of everyone' },
    glyph: '◎',
  },
}

const busy = ref<string | null>(null)
const last = ref<{ kind: string; result: WidgetCommandResultFrame } | null>(null)
const peek = ref<{ at: number; expiresAt: number; self: Point | null; contacts: Point[] } | null>(
  null,
)

interface Point {
  x: number
  y: number
  z: number
}

const stateLine = computed(() => {
  switch (link.state.value) {
    case 'watching':
      return playerToken.value ? t.value(KIT_COPY.connecting) : t.value(KIT_COPY.watching)
    case 'connecting':
      return t.value(KIT_COPY.connecting)
    case 'reconnecting':
      return t.value(KIT_COPY.reconnecting)
    case 'open':
      return t.value(COPY.live)
    case 'ended':
      return t.value(KIT_COPY.ended)
    case 'refused':
      return t.value(KIT_COPY.refused)
    default:
      return t.value(KIT_COPY.closed)
  }
})

/** The `powerup` verb as the orchestrator last described it, or `null` before the `hello`. */
const verb = computed<WidgetCommandView | null>(
  () => link.commands.value.find(command => command.name === VERB) ?? null,
)

/**
 * The kinds to draw, from the verb's own args schema. A manifest that adds a fourth kind
 * gets a fourth button with no code change; one this widget has no face for still gets a
 * button, labelled with its bare name.
 */
const kinds = computed<string[]>(() => {
  const schema = verb.value?.args as { properties?: { kind?: { enum?: unknown } } } | undefined
  const declared = schema?.properties?.kind?.enum
  return Array.isArray(declared)
    ? declared.filter((kind): kind is string => typeof kind === 'string')
    : []
})

const readyInMs = computed(() => Math.max(0, (verb.value?.readyAt ?? 0) - now.value))
const chargesLeft = computed(() => verb.value?.chargesLeft ?? null)
const spent = computed(() => chargesLeft.value !== null && chargesLeft.value <= 0)
const canTap = computed(
  () => link.state.value === 'open' && busy.value === null && readyInMs.value === 0 && !spent.value,
)

/** The ring: full while the verb is ready, emptying as a cooldown runs, empty once the life's charge is spent. */
const ringFill = computed(() => {
  if (spent.value) return 0
  const cooldown = verb.value?.cooldownMs ?? 0
  if (cooldown <= 0 || readyInMs.value === 0) return 1
  return Math.max(0, Math.min(1, 1 - readyInMs.value / cooldown))
})

const RING = 2 * Math.PI * 15

function label(kind: string): string {
  const copy = KIND_COPY[kind]
  return copy ? t.value(copy.label) : kind
}

function note(kind: string): string {
  const copy = KIND_COPY[kind]
  if (!copy) return ''
  if (spent.value) return t.value(COPY.spent)
  if (readyInMs.value > 0) return t.value(COPY.cooldown, { s: Math.ceil(readyInMs.value / 1000) })
  return t.value(copy.note)
}

function glyph(kind: string): string {
  return KIND_COPY[kind]?.glyph ?? '•'
}

function resultLine(entry: { kind: string; result: WidgetCommandResultFrame }): string {
  const { result } = entry
  if (result.status === 'applied') return t.value(KIT_COPY.applied)
  if (result.message) return result.message
  return t.value(result.code === 'not_live' ? KIT_COPY.notLive : KIT_COPY.unavailable)
}

async function tap(kind: string): Promise<void> {
  if (!canTap.value) return
  busy.value = kind
  try {
    const result = await link.send(VERB, { kind })
    last.value = { kind, result }
  } finally {
    busy.value = null
  }
}

// ── The peek ───────────────────────────────────────────────────────────────
// A push is ephemeral by contract: nothing keeps one but this ref, and the next frame
// replaces it. When the last one has expired the canvas goes away on its own — the
// countdown is `now`, the clock the kit ticks, so no timer of our own is needed.
const stopPush = link.onPush((push: WidgetPushFrame) => {
  if (push.name !== PEEK_PUSH) return
  const data = push.data as {
    expiresInMs?: unknown
    self?: unknown
    contacts?: unknown
  }
  const expiresInMs = typeof data.expiresInMs === 'number' ? data.expiresInMs : 0
  peek.value = {
    at: now.value,
    expiresAt: now.value + expiresInMs,
    self: point(data.self),
    contacts: Array.isArray(data.contacts) ? data.contacts.map(point).filter(isPoint) : [],
  }
})
onScopeDispose(stopPush)

function point(value: unknown): Point | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Record<string, unknown>
  const { x, y, z } = candidate
  if (typeof x !== 'number' || typeof y !== 'number') return null
  return { x, y, z: typeof z === 'number' ? z : 0 }
}

function isPoint(value: Point | null): value is Point {
  return value !== null
}

const peekLeftMs = computed(() => (peek.value ? Math.max(0, peek.value.expiresAt - now.value) : 0))
const peeking = computed(() => peek.value !== null && peekLeftMs.value > 0)

/**
 * The dots, in the canvas's own 100×100 box: the player at the middle, everybody else
 * placed by how far and in which direction they are, clamped to the rim. Engine `y` grows
 * north and the box grows south, so it is subtracted.
 */
const dots = computed(() => {
  const frame = peek.value
  if (!frame) return []
  const origin = frame.self ?? { x: 0, y: 0, z: 0 }
  return frame.contacts.map((contact, index) => {
    const dx = (contact.x - origin.x) / PEEK_RANGE
    const dy = (contact.y - origin.y) / PEEK_RANGE
    const distance = Math.hypot(dx, dy)
    const scale = distance > 1 ? 1 / distance : 1
    return {
      key: index,
      cx: 50 + dx * scale * 46,
      cy: 50 - dy * scale * 46,
      far: distance > 1,
      floor: Math.abs(contact.z - origin.z) > PEEK_FLOOR,
    }
  })
})

/** The peek's own ring, emptying over the five seconds. */
const peekFill = computed(() => {
  const frame = peek.value
  if (!frame || frame.expiresAt <= frame.at) return 0
  return Math.max(0, Math.min(1, peekLeftMs.value / (frame.expiresAt - frame.at)))
})
</script>

<template>
  <section class="board" :data-state="link.state.value" :lang="locale">
    <header class="head">
      <h1 class="title">{{ t(COPY.title) }}</h1>
      <span class="state" :data-live="link.state.value === 'open'">{{ stateLine }}</span>
    </header>

    <p v-if="link.state.value === 'watching' && !playerToken" class="hint">{{ t(KIT_COPY.watchingHint) }}</p>
    <p v-else class="hint">{{ spent ? t(COPY.spent) : t(COPY.hint) }}</p>

    <div v-if="kinds.length > 0" class="buttons">
      <button
        v-for="kind in kinds"
        :key="kind"
        type="button"
        class="tap"
        :disabled="!canTap"
        :data-kind="kind"
        :aria-label="label(kind)"
        @click="tap(kind)"
      >
        <span class="ring" aria-hidden="true">
          <svg viewBox="0 0 34 34">
            <circle class="ring-track" cx="17" cy="17" r="15" />
            <circle
              class="ring-fill"
              cx="17"
              cy="17"
              r="15"
              :stroke-dasharray="RING"
              :stroke-dashoffset="RING * (1 - ringFill)"
            />
          </svg>
          <span class="glyph">{{ glyph(kind) }}</span>
        </span>
        <span class="tap-text">
          <span class="tap-title">{{ label(kind) }}</span>
          <span class="tap-sub">{{ busy === kind ? t(COPY.sending) : note(kind) }}</span>
        </span>
      </button>
    </div>

    <p v-if="last" class="result" :data-status="last.result.status">{{ resultLine(last) }}</p>

    <figure v-if="peeking" class="peek" data-testid="peek">
      <figcaption class="peek-head">
        <span class="peek-title">{{ t(COPY.peekTitle) }}</span>
        <span class="peek-left">{{ t(COPY.peekLeft, { s: Math.ceil(peekLeftMs / 1000) }) }}</span>
      </figcaption>
      <svg class="peek-canvas" viewBox="0 0 100 100" role="img" :aria-label="t(COPY.peekTitle)">
        <circle class="peek-edge" cx="50" cy="50" r="48" />
        <circle
          class="peek-sweep"
          cx="50"
          cy="50"
          r="48"
          :stroke-dasharray="2 * Math.PI * 48"
          :stroke-dashoffset="2 * Math.PI * 48 * (1 - peekFill)"
        />
        <line class="peek-cross" x1="50" y1="12" x2="50" y2="88" />
        <line class="peek-cross" x1="12" y1="50" x2="88" y2="50" />
        <circle
          v-for="dot in dots"
          :key="dot.key"
          class="peek-dot"
          :class="{ far: dot.far, floor: dot.floor }"
          :cx="dot.cx"
          :cy="dot.cy"
          r="3.5"
        />
        <circle class="peek-self" cx="50" cy="50" r="2.5" />
      </svg>
      <p class="peek-count">
        {{ dots.length === 0 ? t(COPY.peekAlone) : t(COPY.peekContacts, { n: dots.length }) }}
      </p>
    </figure>
  </section>
</template>

<style>
.board {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 1rem;
}
.head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
}
.title {
  margin: 0;
  font-size: 1.125rem;
  font-weight: 600;
  color: var(--ui-text-highlighted);
}
.state {
  font-family: var(--font-mono);
  font-size: 0.75rem;
  color: var(--ui-text-muted);
}
.state[data-live='true'] {
  color: var(--ui-live);
}
.hint {
  margin: 0;
  font-size: 0.875rem;
  color: var(--ui-text-toned);
}
.buttons {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
  gap: 0.5rem;
}
.tap {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  padding: 0.625rem 0.75rem;
  border: 0;
  border-radius: calc(var(--ui-radius) * 2);
  background: var(--ui-primary);
  color: var(--ui-on-primary);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background-color var(--ui-motion-hover) cubic-bezier(0.4, 0, 0.2, 1), opacity var(--ui-motion-hover) cubic-bezier(0.4, 0, 0.2, 1);
}
.tap:disabled {
  background: var(--ui-bg-accented);
  color: var(--ui-text-muted);
  cursor: default;
}
.ring {
  position: relative;
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 2.125rem;
  height: 2.125rem;
}
.ring svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  transform: rotate(-90deg);
}
.ring-track,
.ring-fill {
  fill: none;
  stroke-width: 2;
}
.ring-track {
  stroke: currentColor;
  opacity: 0.25;
}
.ring-fill {
  stroke: currentColor;
  transition: stroke-dashoffset var(--ui-motion-hover) linear;
}
.glyph {
  font-size: 0.875rem;
  line-height: 1;
}
.tap-text {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 0.125rem;
}
.tap-title {
  font-weight: 600;
}
.tap-sub {
  font-family: var(--font-mono);
  font-size: 0.6875rem;
  font-variant-numeric: tabular-nums;
  opacity: 0.85;
}
.result {
  margin: 0;
  font-size: 0.875rem;
  color: var(--ui-text-toned);
}
.result[data-status='applied'] {
  color: var(--ui-success);
}
.peek {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  margin: 0;
}
.peek-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
  font-size: 0.75rem;
}
.peek-title {
  font-weight: 600;
  color: var(--ui-text-highlighted);
}
.peek-left {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  color: var(--ui-text-muted);
}
.peek-canvas {
  width: 100%;
  max-width: 15rem;
  align-self: center;
  aspect-ratio: 1;
  border-radius: 50%;
  background: var(--ui-bg-elevated);
}
.peek-edge {
  fill: none;
  stroke: var(--ui-border-accented);
  stroke-width: 1;
}
.peek-sweep {
  fill: none;
  stroke: var(--ui-warning);
  stroke-width: 2;
  transform: rotate(-90deg);
  transform-origin: 50% 50%;
}
.peek-cross {
  stroke: var(--ui-border);
  stroke-width: 0.5;
}
.peek-dot {
  fill: var(--ui-live);
}
.peek-dot.far {
  opacity: 0.45;
}
.peek-dot.floor {
  fill: none;
  stroke: var(--ui-live);
  stroke-width: 1.5;
}
.peek-self {
  fill: var(--ui-primary);
}
.peek-count {
  margin: 0;
  font-size: 0.75rem;
  text-align: center;
  color: var(--ui-text-muted);
}
</style>
