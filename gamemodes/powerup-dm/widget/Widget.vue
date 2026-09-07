<script setup lang="ts">
import {
  KIT_COPY,
  useWidget,
  type WidgetCommandResultFrame,
  type WidgetCommandView,
} from '@ezpug/gamemode-kit'
import { computed, ref } from 'vue'

const { link, locale, t, now, playerToken } = useWidget()

const COPY = {
  title: { de: 'Power-up', en: 'Power-up' },
  hint: {
    de: 'Einmal pro Leben. Tippen, wenn du lebst.',
    en: 'Once per life. Tap while you are alive.',
  },
  charges: { de: '{n} übrig', en: '{n} left' },
  ready: { de: 'bereit', en: 'ready' },
  cooldown: { de: 'in {s} s', en: 'in {s} s' },
  sending: { de: 'wird gesendet …', en: 'sending…' },
  live: { de: 'Match läuft', en: 'Match live' },
} as const

const busy = ref<string | null>(null)
const last = ref<{ command: string; result: WidgetCommandResultFrame } | null>(null)

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

function readyIn(command: WidgetCommandView): number {
  return Math.max(0, command.readyAt - now.value)
}

function canTap(command: WidgetCommandView): boolean {
  return (
    link.state.value === 'open' &&
    busy.value === null &&
    readyIn(command) === 0 &&
    (command.chargesLeft === null || command.chargesLeft > 0)
  )
}

function subline(command: WidgetCommandView): string {
  const parts: string[] = []
  if (command.chargesLeft !== null) parts.push(t.value(COPY.charges, { n: command.chargesLeft }))
  const wait = readyIn(command)
  parts.push(wait > 0 ? t.value(COPY.cooldown, { s: Math.ceil(wait / 1000) }) : t.value(COPY.ready))
  return parts.join(' · ')
}

function resultLine(entry: { command: string; result: WidgetCommandResultFrame }): string {
  const { result } = entry
  if (result.status === 'applied') return t.value(KIT_COPY.applied)
  if (result.message) return result.message
  switch (result.code) {
    case 'not_live':
      return t.value(KIT_COPY.notLive)
    default:
      return t.value(KIT_COPY.unavailable)
  }
}

async function tap(command: WidgetCommandView): Promise<void> {
  if (!canTap(command)) return
  busy.value = command.name
  try {
    const result = await link.send(command.name)
    last.value = { command: command.name, result }
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <section class="board" :data-state="link.state.value" :lang="locale">
    <header class="head">
      <h1 class="title">{{ t(COPY.title) }}</h1>
      <span class="state" :data-live="link.state.value === 'open'">{{ stateLine }}</span>
    </header>
    <p v-if="link.state.value === 'watching' && !playerToken" class="hint">{{ t(KIT_COPY.watchingHint) }}</p>
    <p v-else class="hint">{{ t(COPY.hint) }}</p>
    <div class="buttons" v-if="link.commands.value.length > 0">
      <button
        v-for="command in link.commands.value"
        :key="command.name"
        type="button"
        class="tap"
        :disabled="!canTap(command)"
        :data-command="command.name"
        @click="tap(command)"
      >
        <span class="tap-title">{{ command.title[locale] }}</span>
        <span class="tap-sub">{{ busy === command.name ? t(COPY.sending) : subline(command) }}</span>
      </button>
    </div>
    <p v-if="last" class="result" :data-status="last.result.status">{{ resultLine(last) }}</p>
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
  grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr));
  gap: 0.5rem;
}
.tap {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.25rem;
  padding: 0.75rem 1rem;
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
.tap-title {
  font-weight: 600;
}
.tap-sub {
  font-family: var(--font-mono);
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
}
.result {
  margin: 0;
  font-size: 0.875rem;
  color: var(--ui-text-toned);
}
.result[data-status='applied'] {
  color: var(--ui-success);
}
</style>
