/**
 * `@ezpug/cli` — `ezpug-iron`, the operator's command over the Match API
 * (PRD-02 T33). `main.ts` is the process; this is what a test or a script
 * composes instead of it.
 */
export { BOOLEAN_FLAGS, boolFlag, flag, flags, type ParsedArgs, parseArgs } from './args'
export { type CliDependencies, COMMAND_GROUPS, runCli, USAGE } from './cli'
export {
  API_KEY_VAR,
  BASE_URL_VARS,
  baseUrlFrom,
  type CliConfig,
  DEFAULT_BASE_URL,
  type EnvRecord,
  readCliConfig,
} from './config'
export type { CommandContext, DathostImageRunner } from './context'
export {
  createDathostImageRunner,
  DATHOST_SCRIPT_PATH,
  findRepoRoot,
} from './dathost-script'
export { CliUnavailableError, CliUsageError, EXIT } from './exit'
export { createOutput, euros, type Output, orDash, redactSecrets, renderTable } from './output'
export { CLI_VERSION } from './version'
