import type { Clock } from '@ezpug/core'
import type {
  Locale,
  PlayerCommandChargePeriod,
  PlayerCommandSpec,
  WidgetCommandRefusal,
} from '@ezpug/match-api'
import { DEFAULT_LOCALE, validatePlayerCommandArgs } from '@ezpug/match-api'

/**
 * **The SDK's `CommandTable`, in TypeScript** (decision 17, PRD-02 T24): what
 * a simulated server enforces before it answers a widget's tap, in the order
 * the SDK's refusal set lists — the verb exists, the args fit its schema,
 * the cooldown has passed, a charge is left. Only an applied tap spends the
 * charge and starts the cooldown; charges refill when their period turns
 * (`life` on the player's death being dealt — the story respawns everyone
 * next round or, in a deathmatch, at once — `round` on `round_start`, `map`
 * on `going_live`, `match` never). A refusal is a line in the player's
 * language, German when nobody said otherwise, the way the plugin's
 * `Localizer` answers.
 *
 * What the SDK checks and this table cannot: `not_alive`. A simulated
 * player is dealt no health, so the mode's `NotAlive` verdict never comes
 * from here; the harness and the real server prove that path.
 */

/** A tap as the widget socket relays it (the orchestrator's `player_command` frame minus its envelope). */
export interface SimPlayerCommand {
  steamId64: string
  command: string
  args?: Record<string, unknown>
}

/** What the table answered — the `player_command_result` a plugin would send, minus its envelope. */
export interface SimPlayerCommandResult {
  status: 'applied' | 'rejected'
  code?: Extract<
    WidgetCommandRefusal,
    'cooldown' | 'no_charges' | 'unknown_command' | 'invalid_args' | 'not_in_match'
  >
  /** In the player's language. */
  message?: string
  /** For `cooldown`: how long until the verb works again. */
  cooldownMs?: number
  /** Charges left in the current period, where the verb has charges. */
  chargesLeft?: number
}

export interface SimCommandTableOptions {
  clock: Clock
  commands: readonly PlayerCommandSpec[]
  /** The player's language, from the roster; `undefined` is German. */
  localeOf: (steamId64: string) => Locale | undefined
}

export interface SimCommandTable {
  /** Run one tap through the checks. */
  run: (tap: SimPlayerCommand) => SimPlayerCommandResult
  /** A period turned: refill every verb charged per it, for one player or for all. */
  reset: (period: PlayerCommandChargePeriod, steamId64?: string) => void
  /** Forget one player's cooldowns and charges (they left). */
  forget: (steamId64: string) => void
  /** Charges left and the cooldown remaining for one player and every verb — the widget's `hello`. */
  stateOf: (steamId64: string) => { name: string; chargesLeft: number | null; readyInMs: number }[]
}

/** The lines a refusal is said in — the plugin's `Localizer` keys, both languages. */
const LINES: Record<Locale, Record<NonNullable<SimPlayerCommandResult['code']>, string>> = {
  de: {
    unknown_command: 'Diesen Befehl gibt es nicht.',
    invalid_args: 'Die Angaben passen nicht.',
    cooldown: 'Noch nicht wieder bereit.',
    no_charges: 'Keine Ladung mehr übrig.',
    not_in_match: 'Du bist nicht auf dem Server.',
  },
  en: {
    unknown_command: 'No such command.',
    invalid_args: 'The arguments do not fit.',
    cooldown: 'Not ready yet.',
    no_charges: 'No charges left.',
    not_in_match: 'You are not on the server.',
  },
}

/** A refusal in the player's language. */
export function simCommandLine(
  code: NonNullable<SimPlayerCommandResult['code']>,
  locale: Locale | undefined,
): string {
  return LINES[locale ?? DEFAULT_LOCALE][code]
}

interface PlayerUse {
  /** When the verb's cooldown ends, per verb. */
  readyAt: Map<string, number>
  /** Charges spent in the current period, per verb. */
  spent: Map<string, number>
}

export function createSimCommandTable(options: SimCommandTableOptions): SimCommandTable {
  const { clock } = options
  const specs = new Map(options.commands.map(spec => [spec.name, spec]))
  const uses = new Map<string, PlayerUse>()

  const useOf = (steamId64: string): PlayerUse => {
    let use = uses.get(steamId64)
    if (!use) {
      use = { readyAt: new Map(), spent: new Map() }
      uses.set(steamId64, use)
    }
    return use
  }

  const chargesLeft = (spec: PlayerCommandSpec, use: PlayerUse | undefined): number | null =>
    spec.charges ? Math.max(0, spec.charges.count - (use?.spent.get(spec.name) ?? 0)) : null

  const readyIn = (spec: PlayerCommandSpec, use: PlayerUse | undefined): number =>
    Math.max(0, (use?.readyAt.get(spec.name) ?? 0) - clock.now())

  const refuse = (
    steamId64: string,
    code: NonNullable<SimPlayerCommandResult['code']>,
    extra: Pick<SimPlayerCommandResult, 'cooldownMs' | 'chargesLeft'> = {},
  ): SimPlayerCommandResult => ({
    status: 'rejected',
    code,
    message: simCommandLine(code, options.localeOf(steamId64)),
    ...extra,
  })

  return {
    run(tap) {
      const spec = specs.get(tap.command)
      if (!spec) return refuse(tap.steamId64, 'unknown_command')
      if (validatePlayerCommandArgs(spec.args, tap.args) !== null)
        return refuse(tap.steamId64, 'invalid_args')
      const use = useOf(tap.steamId64)
      const wait = readyIn(spec, use)
      const left = chargesLeft(spec, use)
      if (wait > 0)
        return refuse(tap.steamId64, 'cooldown', {
          cooldownMs: wait,
          ...(left !== null && { chargesLeft: left }),
        })
      if (left !== null && left <= 0) return refuse(tap.steamId64, 'no_charges', { chargesLeft: 0 })
      if (spec.cooldownMs > 0) use.readyAt.set(spec.name, clock.now() + spec.cooldownMs)
      if (spec.charges) use.spent.set(spec.name, (use.spent.get(spec.name) ?? 0) + 1)
      return {
        status: 'applied',
        ...(spec.charges && { chargesLeft: chargesLeft(spec, use) as number }),
      }
    },
    reset(period, steamId64) {
      const targets = steamId64 === undefined ? [...uses.values()] : [useOf(steamId64)]
      for (const use of targets) {
        for (const spec of specs.values()) {
          if (spec.charges?.per === period) use.spent.delete(spec.name)
        }
      }
    },
    forget(steamId64) {
      uses.delete(steamId64)
    },
    stateOf(steamId64) {
      const use = uses.get(steamId64)
      return [...specs.values()].map(spec => ({
        name: spec.name,
        chargesLeft: chargesLeft(spec, use),
        readyInMs: readyIn(spec, use),
      }))
    },
  }
}
