import { randomUUID } from 'node:crypto'
import type { Clock } from '@ezpug/core'
import type { Node, NodeEnrolment, NodeEnrolRequest } from '@ezpug/match-api'
import { ApiError, MATCH_API_ERROR_STATUS } from '@ezpug/match-api'
import { LINK_CLOSE_CODES } from '@ezpug/protocol'
import type { Log } from '../log'
import type { MatchStore, NodeRow } from '../match/store'
import { hashToken, mintToken, type RandomBytes } from '../tokens'
import type { NodeRegistry } from './registry'

/**
 * **Enrolling, revoking and draining a node** (decision 23, PRD-02 T12) —
 * the four `/v1/fleet/nodes` routes, and the one place a node token is ever
 * readable.
 *
 * Enrolment is deliberately two steps. `POST` writes the row and mints a
 * **one-time** token that is shown once and never stored in clear; the node
 * spends it on its first `hello` and gets its long-lived node token in the
 * `welcome` (`link/node-link.ts`). So the secret an operator copies into a
 * venue box is worth nothing after the box has used it, and losing it costs
 * one `POST` rather than a re-install.
 *
 * Re-enrolling an existing id is allowed and means what it says: the box is
 * being rebuilt. It mints a fresh one-time token **and revokes the node
 * token in force**, hanging up on whatever is connected — otherwise two
 * agents would answer for one node and the pool would count its capacity
 * twice.
 */

/** How long a one-time enrolment token is worth anything. */
export const NODE_ENROLMENT_TTL_MS = 24 * 60 * 60 * 1000

export interface Nodes {
  list: () => Promise<Node[]>
  /** The row and its one-time token; `keyId` is who pays for what it runs warm. */
  enrol: (body: NodeEnrolRequest, keyId: string) => Promise<NodeEnrolment>
  /** Forget the node: the token dies, the socket closes, the row stays for the story. */
  revoke: (nodeId: string) => Promise<{ ok: true }>
  setDrained: (nodeId: string, drained: boolean) => Promise<Node>
}

export interface NodesOptions {
  clock: Clock
  log: Log
  store: MatchStore
  registry: NodeRegistry
  /** Hang up on a node whose token was just revoked. */
  disconnect: (nodeId: string, code: number, reason: string) => boolean
  enrolmentTtlMs?: number
  random?: RandomBytes
}

export function createNodes(options: NodesOptions): Nodes {
  const { clock, log, store, registry } = options
  const ttlMs = options.enrolmentTtlMs ?? NODE_ENROLMENT_TTL_MS

  const require = async (nodeId: string): Promise<NodeRow> => {
    const row = await store.findNode(nodeId)
    if (!row || row.revokedAt)
      throw new ApiError(MATCH_API_ERROR_STATUS.not_found, 'not_found', `no node ${nodeId}`)
    return row
  }

  /**
   * A node as the fleet route serves it. The connection facts come from the
   * live session where there is one, because a row written five seconds ago
   * is older than the socket; `currentMatches` comes from the ledger, which
   * is the only thing that knows what a container is for.
   */
  const view = async (row: NodeRow): Promise<Node> => {
    const live = registry.get(row.id)
    const open = (await store.listOpenServers('nodes')).filter(server => server.nodeId === row.id)
    const matches = [...new Set(open.map(server => server.matchId).filter(id => id !== null))]
    return {
      id: row.id,
      labels: live?.labels ?? row.labels,
      region: live?.region ?? row.region,
      version: live?.version ?? row.version,
      connected: live !== undefined,
      lastSeenAt: live?.lastSeenAt ?? row.lastSeenAt?.toISOString() ?? null,
      drained: row.drained,
      capacity: {
        total: live?.capacity.maxInstances ?? row.capacityTotal,
        inUse: open.length,
        warm: live?.capacity.warm ?? row.capacityWarm,
      },
      currentMatches: matches,
      enrolledAt: row.enrolledAt.toISOString(),
    }
  }

  return {
    list: async () => {
      const rows = await store.listNodes()
      return Promise.all(rows.map(view))
    },

    enrol: async (body, keyId) => {
      const existing = await store.findNode(body.id)
      const at = clock.date()
      if (existing && !existing.revokedAt) {
        // A rebuild: the box that holds the current token is no longer this node.
        await store.updateNode(body.id, {
          region: body.region,
          labels: body.labels,
          tokenHash: null,
          connected: false,
          enrolledByKeyId: keyId,
        })
        options.disconnect(body.id, LINK_CLOSE_CODES.revoked, 're-enrolled')
        log.info(`node ${body.id}: re-enrolled; the token in force was revoked`)
      } else if (existing) {
        await store.updateNode(body.id, {
          region: body.region,
          labels: body.labels,
          tokenHash: null,
          connected: false,
          drained: false,
          revokedAt: null,
          enrolledByKeyId: keyId,
        })
        log.info(`node ${body.id}: enrolled again after a revoke`)
      } else {
        await store.insertNode({
          id: body.id,
          region: body.region,
          labels: body.labels,
          version: null,
          imageDigest: null,
          connected: false,
          drained: false,
          capacityTotal: 0,
          capacityInUse: 0,
          capacityWarm: 0,
          tokenHash: null,
          enrolledByKeyId: keyId,
          lastSeenAt: null,
          enrolledAt: at,
          revokedAt: null,
        })
        log.info(`node ${body.id}: enrolled in ${body.region}`)
      }
      const token = mintToken('enrolment', options.random)
      await store.insertNodeEnrolment({
        id: randomUUID(),
        nodeId: body.id,
        tokenHash: hashToken(token),
        createdAt: at,
        expiresAt: new Date(at.getTime() + ttlMs),
        usedAt: null,
      })
      const row = await require(body.id)
      return { node: await view(row), token }
    },

    revoke: async nodeId => {
      await require(nodeId)
      await store.updateNode(nodeId, {
        revokedAt: clock.date(),
        tokenHash: null,
        connected: false,
      })
      options.disconnect(nodeId, LINK_CLOSE_CODES.revoked, 'the node was revoked')
      log.info(`node ${nodeId}: revoked`)
      return { ok: true }
    },

    setDrained: async (nodeId, drained) => {
      const row = await require(nodeId)
      await store.updateNode(nodeId, { drained })
      // Tell the agent too: a drained node starts nothing of its own accord.
      registry.setDrained(nodeId, drained)
      return view({ ...row, drained })
    },
  }
}
