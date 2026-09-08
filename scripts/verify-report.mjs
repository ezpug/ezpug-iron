#!/usr/bin/env node
/**
 * **What the extended tier actually ran** (PRD-02 T39a).
 *
 * The suites that cost a night when they go red write a Vitest JSON report
 * under `.verify/` — `.verify/test/` from `pnpm verify`, `.verify/extended/`
 * from each `test:extended`. `scripts/verify-extended.sh` calls this on the
 * way out, green or red, and it prints the counts plus every failed test with
 * the first line of its message. The point is the red run: a tier that dies inside a
 * twenty-minute turbo pipeline used to leave nothing behind but a scrollback,
 * and the file that failed the first `verify:extended` of T39 was lost that
 * way. The reports stay on disk after this prints, named, for whoever asks
 * next.
 *
 *   node scripts/verify-report.mjs .verify
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import process from 'node:process'

/** Every `*.json` under `dir`, at any depth (`.verify/test/`, `.verify/extended/`). */
function reportsIn(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .flatMap(entry =>
      entry.isDirectory()
        ? reportsIn(join(dir, entry.name))
        : entry.name.endsWith('.json')
          ? [join(dir, entry.name)]
          : [],
    )
    .sort()
}

const dim = s => `[2m${s}[0m`
const red = s => `[31m${s}[0m`
const green = s => `[32m${s}[0m`

const dir = process.argv[2] ?? '.verify'

const files = reportsIn(dir)

if (files.length === 0) {
  console.log(`\n[verify:extended] no test report in ${relative(process.cwd(), dir) || dir}\n`)
  process.exit(0)
}

let passed = 0
let failed = 0
let skipped = 0
const failures = []

for (const path of files) {
  let report
  try {
    report = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    failures.push({ suite: path, name: '(unreadable report)', message: String(error) })
    continue
  }
  passed += report.numPassedTests ?? 0
  failed += report.numFailedTests ?? 0
  skipped += (report.numPendingTests ?? 0) + (report.numTodoTests ?? 0)
  for (const suite of report.testResults ?? []) {
    for (const test of suite.assertionResults ?? []) {
      if (test.status !== 'failed') continue
      failures.push({
        suite: relative(process.cwd(), suite.name ?? '?'),
        name: test.fullName ?? test.title ?? '?',
        message: (test.failureMessages ?? [])[0]?.split('\n')[0] ?? '',
      })
    }
  }
}

const counts = `${passed} passed, ${failed} failed, ${skipped} skipped`
console.log(`\n[verify:extended] ${failed === 0 ? green(counts) : red(counts)}`)
console.log(dim(`                  reports: ${files.join(', ')}`))
for (const failure of failures) {
  console.log(`  ${red('×')} ${failure.suite} › ${failure.name}`)
  if (failure.message) console.log(dim(`      ${failure.message}`))
}
console.log('')
