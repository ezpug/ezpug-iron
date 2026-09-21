import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * **The CS2 lane lock** (PRD-03 T13), which is the one piece of this round's
 * lane that is a concurrency primitive rather than a match.
 *
 * There is one CS2 install on this box and two Ralph loops that play matches
 * on it — this repo's `EZPUG_CS2_TESTS` lane and the platform's (its PRD-10
 * T9) — and neither can see the other's process tree, so the agreement between
 * them is a file in `/tmp`. The protocol is written down in
 * `docs/operations.md` because the platform implements its own half of it; this
 * is ours, and it is tested here rather than on hardware for the obvious
 * reason: a lock that is only exercised by the thing it protects is a lock
 * whose stale-and-corrupt paths are exercised by a night nobody is watching.
 *
 * Every wait is driven by an injected clock that moves when it is slept on, so
 * a suite about queueing takes no wall-clock time at all.
 */

const REPO = fileURLToPath(new URL('../../../', import.meta.url))

type LaneLockEntry = {
  token: string
  holder: string
  what: string
  pid: number
  host: string
  since: string
  sinceMs: number
  corrupt?: true
}

type LaneLockModule = {
  LANE_LOCK_PATH: string
  LANE_LOCK_TTL_MS: number
  readLaneLock: (path?: string) => LaneLockEntry | null
  describeLaneLock: (entry: LaneLockEntry | null) => string
  releaseLaneLock: (path: string, token?: string | null) => boolean
  laneLockHolderLives: (
    entry: LaneLockEntry | null,
    options?: { ttlMs?: number; clock?: { now: () => number } },
  ) => boolean
  takeLaneLock: (options: {
    holder?: string
    what?: string
    path?: string
    waitMs?: number
    ttlMs?: number
    pollMs?: number
    clock?: { now: () => number; sleep: (ms: number) => Promise<void> }
    onWait?: (event: { held: LaneLockEntry; broke: boolean; waitedMs: number }) => void
  }) => Promise<{
    path: string
    entry: LaneLockEntry
    broke: LaneLockEntry | null
    waitedMs: number
    release: () => boolean
  }>
}

// A variable path on purpose: the module is a `.mjs` operator script outside
// this app's `tsconfig`, and `iron-match.mjs` — which is plain Node with no
// build step — is the other thing that imports it.
const modulePath = `${REPO}scripts/cs2-lane-lock.mjs`
const lock = (await import(modulePath)) as LaneLockModule

/**
 * **A clock that moves only when it is waited on.** Not `useFakeClock`: this
 * module is the wall-clock exception (like `iron-match.mjs`), so what it takes
 * is a `now`/`sleep` pair and what a test wants is for a sleep to *be* the
 * passage of time. `onSleep` is the seam every contention test needs — it is
 * the moment the other loop can do something.
 */
function testClock(onSleep: (now: number) => void = () => {}) {
  let now = 1_764_000_000_000
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms
      onSleep(now)
      await Promise.resolve()
    },
    jump: (ms: number) => {
      now += ms
    },
  }
}

/** A pid nothing can ever have: the kernel hands out pids strictly below it. */
function deadPid(): number {
  const max = existsSync('/proc/sys/kernel/pid_max')
    ? Number(readFileSync('/proc/sys/kernel/pid_max', 'utf8').trim())
    : 4_194_304
  return Number.isFinite(max) ? max : 4_194_304
}

let dir = ''
let path = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ezpug-lane-lock-'))
  path = join(dir, 'lane.lock')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** What another loop's lock file looks like from here. */
function held(entry: Partial<LaneLockEntry> = {}): LaneLockEntry {
  const full: LaneLockEntry = {
    token: 'token-of-the-other-loop',
    holder: 'ezpug-platform',
    what: 'the golden path, a 2v2 pug',
    pid: process.pid,
    host: hostname(),
    since: new Date(1_764_000_000_000).toISOString(),
    sinceMs: 1_764_000_000_000,
    ...entry,
  }
  writeFileSync(path, `${JSON.stringify(full, null, 2)}\n`)
  return full
}

describe('the CS2 lane lock', () => {
  it('takes a free lane, says who has it, and gives it back', async () => {
    const clock = testClock()
    const taken = await lock.takeLaneLock({
      path,
      clock,
      holder: 'ezpug-iron',
      what: 'pug-5v5',
    })

    expect(taken.waitedMs, 'a free lane was waited for').toBe(0)
    expect(taken.broke, 'a free lane had a corpse on it').toBeNull()
    const entry = lock.readLaneLock(path)
    expect(entry?.holder).toBe('ezpug-iron')
    expect(entry?.what).toBe('pug-5v5')
    expect(entry?.pid).toBe(process.pid)
    expect(entry?.host).toBe(hostname())
    expect(entry?.token).toBe(taken.entry.token)
    // The line a waiting loop prints, and the line the `status` verb prints.
    expect(lock.describeLaneLock(entry)).toContain('ezpug-iron')
    expect(lock.describeLaneLock(entry)).toContain(`pid ${process.pid}`)
    expect(lock.describeLaneLock(entry)).toContain('pug-5v5')

    expect(taken.release()).toBe(true)
    expect(existsSync(path), 'the lane was not given back').toBe(false)
    expect(lock.describeLaneLock(lock.readLaneLock(path))).toBe('nobody')
  })

  it('queues behind a live holder and takes the lane the moment it is free', async () => {
    const theirs = held()
    let polls = 0
    const waits: string[] = []
    // The other loop finishes its match on the third look.
    const clock = testClock(() => {
      if (++polls === 3) lock.releaseLaneLock(path, theirs.token)
    })

    const taken = await lock.takeLaneLock({
      path,
      clock,
      holder: 'ezpug-iron',
      pollMs: 5_000,
      waitMs: 45 * 60_000,
      onWait: ({ held: who, broke }) => waits.push(`${broke ? 'broke' : 'waited'}:${who.holder}`),
    })

    expect(polls, 'the waiter did not wait for the holder').toBe(3)
    expect(taken.waitedMs).toBe(15_000)
    expect(taken.broke, 'a live holder was treated as a corpse').toBeNull()
    expect(waits).toEqual([
      'waited:ezpug-platform',
      'waited:ezpug-platform',
      'waited:ezpug-platform',
    ])
    expect(lock.readLaneLock(path)?.holder).toBe('ezpug-iron')
  })

  it('gives up naming the holder rather than starting a second match', async () => {
    held({ what: 'a golden-path match that will not end' })
    const clock = testClock()

    await expect(
      lock.takeLaneLock({ path, clock, pollMs: 60_000, waitMs: 10 * 60_000 }),
    ).rejects.toThrow(/ezpug-platform.*golden-path match that will not end/s)
    // **And the holder's lock is still theirs.** A waiter that gave up must
    // not leave the lane looking free.
    expect(lock.readLaneLock(path)?.holder).toBe('ezpug-platform')
  })

  it('steps over a holder whose process is gone', async () => {
    const gone = deadPid()
    // The premise, asserted rather than assumed: this pid answers nobody.
    expect(() => process.kill(gone, 0)).toThrow()
    const theirs = held({ pid: gone, holder: 'ezpug-platform' })
    const clock = testClock()

    const taken = await lock.takeLaneLock({ path, clock, holder: 'ezpug-iron' })

    expect(taken.waitedMs, 'a corpse was waited for').toBe(0)
    expect(taken.broke?.token, 'the corpse was not recorded').toBe(theirs.token)
    expect(lock.readLaneLock(path)?.holder).toBe('ezpug-iron')
  })

  it('steps over a lock older than the TTL, whatever its pid says', async () => {
    // Our own pid — alive by construction — so age is the only thing that can
    // break this one. That is the run killed between taking the lock and
    // releasing it, in a container whose pids this side cannot see at all.
    const theirs = held({ holder: 'ezpug-platform' })
    const clock = testClock()
    clock.jump(lock.LANE_LOCK_TTL_MS + 60_000)

    const taken = await lock.takeLaneLock({ path, clock })
    expect(taken.broke?.token).toBe(theirs.token)
  })

  it('judges a lock from another host by its age alone', () => {
    const clock = testClock()
    const elsewhere = { ...held({ host: 'some-other-box', pid: deadPid() }) }
    // A pid on another machine says nothing about whether that run is alive.
    expect(lock.laneLockHolderLives(elsewhere, { clock })).toBe(true)
    clock.jump(lock.LANE_LOCK_TTL_MS + 1)
    expect(lock.laneLockHolderLives(elsewhere, { clock })).toBe(false)
  })

  it('treats a file it did not write as a corpse', async () => {
    writeFileSync(path, 'this is not the lock protocol\n')
    expect(lock.readLaneLock(path)).toEqual({ corrupt: true })
    expect(lock.describeLaneLock(lock.readLaneLock(path))).toContain('did not write this file')

    const clock = testClock()
    const taken = await lock.takeLaneLock({ path, clock })
    expect(taken.waitedMs).toBe(0)
    expect(lock.readLaneLock(path)?.token).toBe(taken.entry.token)
  })

  it('never removes a lock that is no longer its own', async () => {
    const clock = testClock()
    const mine = await lock.takeLaneLock({ path, clock, holder: 'ezpug-iron' })
    // Ninety minutes later the other loop declares this run dead and takes the
    // lane. When the run finally wakes up and releases, it must leave the new
    // holder alone — one loop releasing another's lock is exactly the
    // collision the file exists to prevent.
    const theirs = held({ holder: 'ezpug-platform', token: 'a-newer-token' })

    expect(mine.release()).toBe(false)
    expect(lock.readLaneLock(path)?.token).toBe(theirs.token)
  })

  it('leaves no debris behind a break', async () => {
    held({ pid: deadPid() })
    const clock = testClock()
    const taken = await lock.takeLaneLock({ path, clock })
    taken.release()
    // The break moves the corpse aside before it removes it (the rename is
    // what keeps two waiters from both taking a dead lane); nothing of that
    // may survive in the directory.
    expect(existsSync(path)).toBe(false)
    expect(
      spawnSync('ls', [dir], { encoding: 'utf8' }).stdout.trim(),
      'the break left a file behind',
    ).toBe('')
  })

  it('answers an operator from the command line', () => {
    const free = spawnSync('node', [modulePath, 'status'], {
      encoding: 'utf8',
      env: { ...process.env, EZPUG_CS2_LANE_LOCK: path },
    })
    expect(free.stdout).toContain('free')
    expect(free.status, 'a free lane is exit 0').toBe(0)

    held({ pid: deadPid(), holder: 'ezpug-platform' })
    const taken = spawnSync('node', [modulePath, 'status'], {
      encoding: 'utf8',
      env: { ...process.env, EZPUG_CS2_LANE_LOCK: path },
    })
    expect(taken.stdout).toContain('ezpug-platform')
    expect(taken.stdout, 'a dead holder is not pointed out').toContain('that run is gone')
    expect(taken.status, 'a held lane is exit 1').toBe(1)

    const broken = spawnSync('node', [modulePath, 'break'], {
      encoding: 'utf8',
      env: { ...process.env, EZPUG_CS2_LANE_LOCK: path },
    })
    expect(broken.stdout).toContain('took the CS2 lane away from ezpug-platform')
    expect(existsSync(path)).toBe(false)
  })

  it('defaults to the path both loops have agreed on', () => {
    // The platform's lane is a different checkout implementing the same
    // protocol (`docs/operations.md`), so this default is a contract between
    // two repositories and not an implementation detail.
    expect(lock.LANE_LOCK_PATH).toBe('/tmp/ezpug-cs2-lane.lock')
  })
})
