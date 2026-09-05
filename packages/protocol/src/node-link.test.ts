import { describe, expect, it } from 'vitest'
import { NODE_FRAME_FIXTURES, ORCHESTRATOR_NODE_FRAME_FIXTURES } from './fixtures'
import {
  NODE_FRAME_TYPES,
  nodeFrameSchema,
  ORCHESTRATOR_NODE_FRAME_TYPES,
  orchestratorNodeFrameSchema,
} from './node-link'

describe('the node link', () => {
  it('parses one fixture per frame type, both directions', () => {
    for (const type of NODE_FRAME_TYPES) {
      expect(nodeFrameSchema.parse(NODE_FRAME_FIXTURES[type]).type).toBe(type)
    }
    for (const type of ORCHESTRATOR_NODE_FRAME_TYPES) {
      expect(orchestratorNodeFrameSchema.parse(ORCHESTRATOR_NODE_FRAME_FIXTURES[type]).type).toBe(
        type,
      )
    }
  })

  it('a node is LAN capacity unless it says otherwise', () => {
    const { lan: _lan, labels: _labels, ...bare } = NODE_FRAME_FIXTURES.hello
    const parsed = nodeFrameSchema.parse(bare)
    if (parsed.type !== 'hello') throw new Error('not a hello')
    expect(parsed.lan).toBe(true)
    expect(parsed.labels).toEqual({})
  })

  it('insists on a real image digest', () => {
    expect(
      nodeFrameSchema.safeParse({ ...NODE_FRAME_FIXTURES.hello, imageDigest: 'latest' }).success,
    ).toBe(false)
  })

  it('the node token is optional in welcome and never anywhere else', () => {
    const { nodeToken: _token, ...bare } = ORCHESTRATOR_NODE_FRAME_FIXTURES.welcome
    expect(orchestratorNodeFrameSchema.safeParse(bare).success).toBe(true)
    for (const type of ORCHESTRATOR_NODE_FRAME_TYPES) {
      if (type === 'welcome') continue
      expect(JSON.stringify(ORCHESTRATOR_NODE_FRAME_FIXTURES[type])).not.toContain('nodeToken')
    }
  })

  it('a start spec names the server token the container dials in with, and upper-case env only', () => {
    const start = ORCHESTRATOR_NODE_FRAME_FIXTURES.start
    expect(orchestratorNodeFrameSchema.parse(start).type).toBe('start')
    const badEnv = { ...start, instance: { ...start.instance, env: { lower: 'x' } } }
    expect(orchestratorNodeFrameSchema.safeParse(badEnv).success).toBe(false)
  })
})
