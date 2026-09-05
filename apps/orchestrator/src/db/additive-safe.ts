/**
 * The additive-safe guard (CLAUDE.md "Migrations are additive-safe").
 *
 * `main` stays deployable: a migration runs while the previous release is
 * still serving traffic, so it may never remove or reshape something that
 * release still uses. This module recognises the statements that break that
 * rule; `additive-safe.test.ts` runs it over every file in `drizzle/`, so a
 * destructive migration fails `pnpm verify` instead of production. The
 * platform's `packages/db/src/additive-safe.ts`, ported whole.
 *
 * The escape hatch is deliberate and visible — the contract phase of an
 * expand → migrate → contract change is legitimate once nothing reads the
 * column any more. Put the marker on the line above the statement:
 *
 * ```sql
 * -- ezpug:contract-phase display_name unused since the 2026-09 release
 * ALTER TABLE "servers" DROP COLUMN "display_name";
 * ```
 */

/** The marker comment that acknowledges a deliberate destructive statement. */
export const CONTRACT_PHASE_MARKER = 'ezpug:contract-phase'

export interface MigrationViolation {
  readonly file: string
  /** 1-based line number in the migration file. */
  readonly line: number
  readonly rule: string
  readonly statement: string
}

interface Rule {
  readonly name: string
  readonly pattern: RegExp
}

/**
 * Statements that break a still-running previous release. Renames and type
 * changes are as destructive as drops — the old code reads the old name.
 */
const RULES: readonly Rule[] = [
  { name: 'drop-table', pattern: /\bdrop\s+table\b/i },
  { name: 'drop-column', pattern: /\bdrop\s+column\b/i },
  { name: 'drop-schema', pattern: /\bdrop\s+schema\b/i },
  { name: 'drop-type', pattern: /\bdrop\s+type\b/i },
  { name: 'rename', pattern: /\brename\s+(?:column\s+|constraint\s+)?to\b|\brename\s+column\b/i },
  {
    name: 'alter-column-type',
    pattern: /\balter\s+column\b[\s\S]*?\bset\s+data\s+type\b|\balter\s+column\b[^\n]*\btype\b/i,
  },
  { name: 'set-not-null', pattern: /\bset\s+not\s+null\b/i },
  { name: 'truncate', pattern: /\btruncate\b/i },
]

const COMMENT = /^\s*--/

/**
 * Find every destructive statement in one migration file that is not
 * acknowledged by a {@link CONTRACT_PHASE_MARKER} comment on a preceding
 * comment line.
 */
export function checkMigrationSql(sql: string, file: string): MigrationViolation[] {
  const lines = sql.split('\n')
  const violations: MigrationViolation[] = []

  lines.forEach((text, index) => {
    if (COMMENT.test(text)) return
    const rule = RULES.find(candidate => candidate.pattern.test(text))
    if (!rule || isAcknowledged(lines, index)) return
    violations.push({
      file,
      line: index + 1,
      rule: rule.name,
      statement: text.trim(),
    })
  })

  return violations
}

/**
 * A marker counts when it sits on the comment lines immediately above the
 * statement — close enough that a reviewer reads the reason and the statement
 * together, and far enough that a file-wide marker cannot wave through a
 * second, unrelated drop.
 */
function isAcknowledged(lines: readonly string[], index: number): boolean {
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    const text = lines[cursor] ?? ''
    if (text.trim() === '') continue
    if (!COMMENT.test(text)) return false
    if (text.includes(CONTRACT_PHASE_MARKER)) return true
  }
  return false
}

/** Human-readable report for a failing test or a pre-commit hook. */
export function formatViolations(violations: readonly MigrationViolation[]): string {
  return violations.map(v => `  ${v.file}:${v.line} [${v.rule}] ${v.statement}`).join('\n')
}
