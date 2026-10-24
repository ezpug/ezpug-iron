import type { NodeGame, NodeImage } from './node-link'

/**
 * **A node's game, held against its image's proof** (PRD-10 T8, decision
 * 41) — one judgement, said in the same words by the agent's boot log and
 * by the `nodes` provider's `game.canary` and `game.hud`, so an operator
 * reading either reads the other.
 *
 * The proof is the build on which the dev-node canary (`pnpm cs2:canary`)
 * last went green with the image's exact pins. A node whose volume holds
 * that build is `green`; anything else is `unproven`, with the node and
 * both builds in the reason — never `red`, because a node is not refused:
 * a venue has only the server it has. A volume *older* than the proof is
 * the common case (the image moved, the volume did not) and its reason
 * says what to run.
 */

export type NodeGameState = 'green' | 'unproven'

export interface NodeGameVerdict {
  state: NodeGameState
  /** The node's build (its `PatchVersion`), or null when its volume could not say. */
  build: string | null
  /** One sentence; null when green. */
  reason: string | null
}

export interface NodeGameJudgement {
  canary: NodeGameVerdict
  hud: NodeGameVerdict
}

/**
 * Dotted build numbers compared part by part as numbers (`1.41.10.0` is
 * after `1.41.9.2`); a part that is not a number compares as text.
 */
export function compareBuilds(a: string, b: string): number {
  const left = a.split('.')
  const right = b.split('.')
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const l = left[index] ?? '0'
    const r = right[index] ?? '0'
    const ln = Number(l)
    const rn = Number(r)
    const order = Number.isFinite(ln) && Number.isFinite(rn) ? ln - rn : l < r ? -1 : l > r ? 1 : 0
    if (order !== 0) return order < 0 ? -1 : 1
  }
  return 0
}

const samePins = (a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) if (a[key] !== b[key]) return false
  return keys.size > 0
}

/**
 * Judge one node. `who` names it in the reason (`node devbox`, `this node`).
 * A node that sent no `game` or no `image` (an agent older than 0.2.0) is
 * unproven and says so.
 */
export function judgeNodeGame(
  who: string,
  game: NodeGame | undefined,
  image: NodeImage | undefined,
): NodeGameJudgement {
  const build = game?.patchVersion ?? null
  const unproven = (reason: string): NodeGameJudgement => {
    const verdict: NodeGameVerdict = { state: 'unproven', build, reason }
    return { canary: verdict, hud: verdict }
  }
  if (game === undefined || image === undefined)
    return unproven(`${who} does not state its game build (an agent older than 0.2.0)`)
  const revision = image.revision ?? 'of unknown revision'
  if (build === null)
    return unproven(
      `${who} cannot read its game build (no steam.inf on its volume): run \`cs2:install\` on ${who}`,
    )
  const proof = image.proven
  if (proof === null)
    return unproven(
      `${who} runs CS2 ${build}; its image ${revision} carries no dev-node canary proof`,
    )
  if (!samePins(proof.pins, image.pins))
    return unproven(
      `${who} runs CS2 ${build}; its image ${revision} carries a proof for other pins than it was built with`,
    )
  const order = compareBuilds(build, proof.build)
  if (order < 0)
    return unproven(
      `${who} runs CS2 ${build}, older than ${proof.build} its image ${revision} was proven on: run \`cs2:install\` on ${who}`,
    )
  if (order > 0)
    return unproven(
      `${who} runs CS2 ${build}; its image ${revision} was proven on ${proof.build} only`,
    )
  const canary: NodeGameVerdict = { state: 'green', build, reason: null }
  return {
    canary,
    hud: proof.hud
      ? canary
      : {
          state: 'unproven',
          build,
          reason: `${who} runs CS2 ${build}; its image ${revision} was proven on it without the hud-on row`,
        },
  }
}
