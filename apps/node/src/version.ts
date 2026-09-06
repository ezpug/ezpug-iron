/**
 * The agent's version, as `hello.version` reports it. A constant rather
 * than a read of `package.json`, because the bundle the image runs has no
 * `package.json` beside it; `version.test.ts` holds the two together.
 */
export const NODE_AGENT_VERSION = '0.1.0'
