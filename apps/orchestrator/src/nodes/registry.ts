import type { NodeInstance, NodeLinkCapacity, OrchestratorNodeFrame } from '@ezpug/protocol'

/**
 * **Which nodes are on the wire right now** — the one place the node link
 * (`link/node-link.ts`, the socket) and the node provider
 * (`providers/nodes/provider.ts`, the capacity) meet, so neither has to
 * know the other exists. The link attaches a session and keeps its snapshot
 * fresh; the provider reads what is connected, sends frames down it and
 * watches for changes.
 *
 * It holds **connections**, never enrolments: a node that is not here is a
 * node with no capacity, and the row in `nodes` is what says it still
 * exists (decision 23, PRD-02 T12).
 */

/** One connected `ezpug-node`, as everything upstream of the socket sees it. */
export interface ConnectedNode {
  readonly id: string
  readonly region: string
  /** Where players reach its containers: the `address` label, else the socket's own peer address. */
  readonly address: string
  readonly lan: boolean
  readonly labels: Readonly<Record<string, string>>
  readonly capacity: NodeLinkCapacity
  readonly imageDigest: string
  readonly version: string
  /** The containers the node last reported, whole. */
  instances: readonly NodeInstance[]
  /** ISO timestamp of the last frame from this node. */
  lastSeenAt: string
  /** The operator's drain (`nodes.drained`), as `welcome` and `drain` carry it. */
  drained: boolean
  /** True when the frame was written; false when the socket had already gone. */
  send: (frame: OrchestratorNodeFrame) => boolean
  /** Hang up on it — an un-enrolment, a shutdown. */
  disconnect: (code: number, reason: string) => void
}

/** What happened to the pool. `instances` fires on every snapshot, including the `hello`'s. */
export interface NodeWatcher {
  connected?: (node: ConnectedNode) => void
  instances?: (node: ConnectedNode) => void
  disconnected?: (nodeId: string, lastSeenAt: string) => void
}

export interface NodeRegistry {
  /** A `hello` was accepted. Replaces any session under the same id. */
  attach: (node: ConnectedNode) => void
  /** The socket for `node` closed. Ignored when a newer session already replaced it. */
  detach: (node: ConnectedNode) => void
  get: (nodeId: string) => ConnectedNode | undefined
  all: () => ConnectedNode[]
  /** A fresh snapshot from a node. */
  setInstances: (nodeId: string, instances: readonly NodeInstance[], at: string) => void
  /** The operator drained or undrained it: tell the node and remember. */
  setDrained: (nodeId: string, drained: boolean) => void
  /** Watch the pool. Returns the unsubscribe. */
  watch: (watcher: NodeWatcher) => () => void
}

export function createNodeRegistry(): NodeRegistry {
  const nodes = new Map<string, ConnectedNode>()
  const watchers = new Set<NodeWatcher>()

  const announce = (pick: (watcher: NodeWatcher) => (() => void) | undefined): void => {
    for (const watcher of [...watchers]) pick(watcher)?.()
  }

  return {
    attach(node) {
      nodes.set(node.id, node)
      announce(watcher => watcher.connected && (() => watcher.connected?.(node)))
    },
    detach(node) {
      if (nodes.get(node.id) !== node) return
      nodes.delete(node.id)
      announce(
        watcher => watcher.disconnected && (() => watcher.disconnected?.(node.id, node.lastSeenAt)),
      )
    },
    get: nodeId => nodes.get(nodeId),
    all: () => [...nodes.values()],
    setInstances(nodeId, instances, at) {
      const node = nodes.get(nodeId)
      if (!node) return
      node.instances = [...instances]
      node.lastSeenAt = at
      announce(watcher => watcher.instances && (() => watcher.instances?.(node)))
    },
    setDrained(nodeId, drained) {
      const node = nodes.get(nodeId)
      if (!node) return
      node.drained = drained
      node.send({ type: drained ? 'drain' : 'undrain' })
      announce(watcher => watcher.instances && (() => watcher.instances?.(node)))
    },
    watch(watcher) {
      watchers.add(watcher)
      return () => void watchers.delete(watcher)
    },
  }
}
