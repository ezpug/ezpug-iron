#!/usr/bin/env node
// **The CS2 lane lock** (PRD-03 T13): one file, taken by every run that is
// about to start a match on this box's shared `ezpug-iron-cs2` container.
//
//   node scripts/cs2-lane-lock.mjs status        who holds it (or nobody), and who is queued
//   node scripts/cs2-lane-lock.mjs break         take it away from a run that died
//
// There is **one** CS2 install on this box (68 GB, one container, one game
// port) and **two** loops that play matches on it: this repo's
// `EZPUG_CS2_TESTS` lane and the platform's own real-server lane
// (`/root/ezpug`, its PRD-10 T9). Neither can see the other's process tree, so
// the agreement between them is a file: whoever is about to allocate a server
// on the node provider creates it, and whoever finds it there waits.
//
// **The protocol is the contract, not this module.** The platform is a
// different checkout and never imports this repo, so what both sides implement
// is written down in `docs/operations.md` ("The lane lock") — the path, the
// JSON, when a lock may be broken. Forty lines on either side; this is ours.
//
// It is a cooperative lock and it says so: nothing stops a run that never
// takes it, and the orchestrator's own capacity refusal is still the floor
// underneath (a node with one slot refuses the second allocation, which is a
// red test rather than two matches). The lock exists so that the two loops
// **queue** instead of colliding, and so the one that waits says who it is
// waiting for.
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

/**
 * **Where it lives, and it is deliberately not in either repo.** Two
 * checkouts share it, so it belongs to the box; `/tmp` also means a reboot
 * frees it, which is the right answer for a lock whose holder cannot survive
 * one.
 */
export const LANE_LOCK_PATH = process.env.EZPUG_CS2_LANE_LOCK ?? '/tmp/ezpug-cs2-lane.lock'

/**
 * **When a lock is old enough to be somebody's corpse.** Above any budget the
 * lane's ladder hands a row (the longest is half an hour) and above the
 * platform's single golden-path match, so a lock this old is a run that was
 * killed between taking it and releasing it — the case a pid check cannot
 * catch when the two loops are in different containers or the pid was reused.
 */
export const LANE_LOCK_TTL_MS = 90 * 60_000

/**
 * **The queue beside the lock** (PRD-04 T1, issue #1): a directory of
 * tickets, one per waiter, so that the lane goes to whoever asked first and
 * not to whoever polls fastest. Without it, a matrix whose next row is a new
 * process taking the lock the moment the last one let go won six handovers in
 * a row against a waiter that looked every five seconds.
 */
export function laneQueuePath(path = LANE_LOCK_PATH) {
  return `${path}.queue`
}

/** How often a waiter looks again. */
export const LANE_LOCK_POLL_MS = 5_000

/** How long a waiter waits before it gives up and says who it waited for. */
export const LANE_LOCK_WAIT_MS = 45 * 60_000

/**
 * **The wall clock, in one place** — the same exception `iron-match.mjs`
 * makes and for the same reason: a lock on real hardware waits in real time
 * and there is nothing to inject. Injected anyway (`options.clock`), because
 * the tests of a waiting primitive must not wait.
 */
export const wallClock = {
  // biome-ignore lint/plugin: a cooperative file lock on real hardware, waiting in real time
  now: () => Date.now(),
  // biome-ignore lint/plugin: as above — there is no clock to arm a timer on
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
}

/**
 * What the file says, or `null` when there is none. A file that is not the
 * JSON this module writes comes back `{ corrupt: true }`: something wrote
 * there, nobody can be named, and it is broken like any other corpse.
 */
export function readLaneLock(path = LANE_LOCK_PATH) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  try {
    const entry = JSON.parse(raw)
    if (entry === null || typeof entry !== 'object' || typeof entry.token !== 'string')
      return { corrupt: true }
    return entry
  } catch {
    return { corrupt: true }
  }
}

/** One line a human can act on: who holds it, since when, and what for. */
export function describeLaneLock(entry) {
  if (entry === null) return 'nobody'
  if (entry.corrupt === true) return 'something that did not write this file'
  const where = entry.host === hostname() ? `pid ${entry.pid}` : `pid ${entry.pid} on ${entry.host}`
  return `${entry.holder} (${where}) since ${entry.since}${entry.what ? ` — ${entry.what}` : ''}`
}

/**
 * **Is the holder still there?** Two questions, and only the first is exact:
 * a pid on *this* host either answers a signal or it does not, and a lock
 * from another host (or one whose pid was reused by something else) is only
 * ever judged by its age.
 */
export function laneLockHolderLives(entry, { ttlMs = LANE_LOCK_TTL_MS, clock = wallClock } = {}) {
  if (entry === null || entry.corrupt === true) return false
  const age = clock.now() - Number(entry.sinceMs ?? 0)
  if (!Number.isFinite(age) || age > ttlMs) return false
  if (entry.host !== hostname() || !Number.isInteger(entry.pid)) return true
  try {
    // Signal 0 asks without sending: it throws `ESRCH` for a pid nobody has,
    // and `EPERM` for one this user may not signal — which is an answer too.
    process.kill(entry.pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * **The living tickets in the queue, oldest first** — and the dead ones
 * removed on the way. A ticket is judged by the lock's own corpse rules
 * (`laneLockHolderLives`): a pid on this host that answers no signal, an age
 * above the TTL, or contents that are not the lock's JSON. Anyone may remove a
 * dead ticket, and a plain unlink is safe where a lock needs a rename: a
 * ticket's name carries its token, so nobody ever creates a *successor* under
 * the same name.
 *
 * `prune: false` only reads — the `status` verb looks and touches nothing.
 *
 * Order is `sinceMs`, then the file name (which is `<sinceMs>-<token>.json`),
 * so two tickets from the same millisecond still have one answer on both
 * sides.
 */
export function readLaneQueue(
  path = LANE_LOCK_PATH,
  { ttlMs = LANE_LOCK_TTL_MS, clock = wallClock, prune = true } = {},
) {
  const queue = laneQueuePath(path)
  let names
  try {
    names = readdirSync(queue)
  } catch {
    return []
  }
  const living = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const file = join(queue, name)
    const ticket = readLaneLock(file)
    if (ticket === null) continue
    if (!laneLockHolderLives(ticket, { ttlMs, clock })) {
      if (!prune) continue
      try {
        unlinkSync(file)
      } catch {
        /* somebody else removed the same corpse */
      }
      continue
    }
    living.push({ ...ticket, file, name })
  }
  return living.sort(
    (a, b) => a.sinceMs - b.sinceMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  )
}

/**
 * **Take a corpse's lock away.** The rename is what makes this safe between
 * two loops: exactly one waiter can move a given file aside, so two that
 * judge the same lock dead do not both go on to create their own — the loser
 * finds nothing to rename and goes round again.
 *
 * The residual window is written down rather than pretended away: between the
 * read that judged the holder dead and the rename, a *successor* could have
 * taken the lock legitimately. The token of what was actually moved is
 * checked against the token that was judged, and a mismatch puts the file
 * back; what is left is the microsecond in which the successor's own release
 * would find its lock already gone, and it is why this module never breaks a
 * lock that is both young and answering.
 */
function breakLaneLock(path, judged) {
  const aside = `${path}.stale-${randomUUID()}`
  try {
    renameSync(path, aside)
  } catch {
    return false
  }
  const moved = readLaneLock(aside)
  if (moved !== null && moved.corrupt !== true && judged.corrupt !== true) {
    if (moved.token !== judged.token) {
      // Not the lock we judged. Put it back where it was, unless somebody has
      // already created a new one there — in which case the newest wins and
      // this waiter simply keeps waiting.
      try {
        if (!existsSync(path)) renameSync(aside, path)
        else unlinkSync(aside)
      } catch {
        /* the file is somebody else's problem now; the waiter loops */
      }
      return false
    }
  }
  try {
    unlinkSync(aside)
  } catch {
    /* already gone */
  }
  return true
}

/**
 * **Give the lock back.** Only ever removes a file that still carries our own
 * token: a run whose lock was broken while it was still going (the ninety
 * minutes) must not delete the lock of whoever took it afterwards.
 */
export function releaseLaneLock(path = LANE_LOCK_PATH, token = null) {
  const held = readLaneLock(path)
  if (held === null) return false
  if (token !== null && held.token !== token) return false
  try {
    unlinkSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * **Take the lane, waiting for whoever has it.**
 *
 * Resolves with the lock held and a `release()` that gives it back; rejects
 * when the wait runs out, naming the holder it waited for — which is the
 * whole point of a lock file that carries who and what and since when. A
 * caller releases in a `finally`, the way it releases a server.
 */
export async function takeLaneLock({
  holder = 'ezpug-iron',
  what = '',
  path = LANE_LOCK_PATH,
  waitMs = LANE_LOCK_WAIT_MS,
  ttlMs = LANE_LOCK_TTL_MS,
  pollMs = LANE_LOCK_POLL_MS,
  clock = wallClock,
  onWait = () => {},
} = {}) {
  // A ticket is judged by the same TTL as a lock, so a waiter that outwaited
  // it would find its own place in the queue removed as a corpse.
  if (waitMs >= ttlMs)
    throw new Error(
      `a wait of ${Math.round(waitMs / 60_000)} minutes for the CS2 lane is not below the ` +
        `${Math.round(ttlMs / 60_000)}-minute TTL its ticket is judged by`,
    )
  const token = randomUUID()
  const startedAt = clock.now()
  const deadline = startedAt + waitMs
  /** The corpse this run had to step over, if it did — the lane's note says so. */
  let broke = null
  /** A file that keeps vanishing between the create and the read is a loop with no sleep in it. */
  let spins = 0
  /** Our place in the queue, dropped the first time the lane is not ours for the asking. */
  let ticket = null

  const stamp = at => ({
    token,
    holder,
    what,
    pid: process.pid,
    host: hostname(),
    since: new Date(at).toISOString(),
    sinceMs: at,
  })

  try {
    for (;;) {
      // **The queue first.** A living ticket older than ours — or any living
      // ticket at all, while we hold none, because a run without a ticket
      // counts as the newest — means the lane is somebody else's next, free
      // or not.
      const queue = readLaneQueue(path, { ttlMs, clock })
      const mine = ticket === null ? -1 : queue.findIndex(t => t.token === token)
      // A ticket that has gone from under us (an operator cleared the queue)
      // is no place at all: the run queues again, at the back.
      if (ticket !== null && mine === -1) ticket = null
      const ahead = ticket === null ? queue : queue.slice(0, mine)

      if (ahead.length === 0) {
        const entry = stamp(clock.now())
        try {
          // `wx` is the whole lock: an exclusive create is one syscall and two
          // processes cannot both win it.
          writeFileSync(path, `${JSON.stringify(entry, null, 2)}\n`, { flag: 'wx' })
          return {
            path,
            entry,
            broke,
            waitedMs: clock.now() - startedAt,
            release: () => releaseLaneLock(path, token),
          }
        } catch (error) {
          if (error?.code !== 'EEXIST') throw error
        }
      }

      const held = readLaneLock(path)
      if (held === null && ahead.length === 0) {
        // It was released between our create and our read. Straight round again.
        if (++spins > 100)
          throw new Error(`the CS2 lane lock at ${path} kept appearing and vanishing`)
        continue
      }
      if (
        held !== null &&
        !laneLockHolderLives(held, { ttlMs, clock }) &&
        breakLaneLock(path, held)
      ) {
        broke = held
        onWait({ held, broke: true, ahead, waitedMs: clock.now() - startedAt, path })
        continue
      }

      if (ticket === null) {
        // One exclusive create, named so that a directory listing is the
        // queue's order. Its age is the moment it was dropped, not the moment
        // this run started: a run that found the lane free did not queue.
        const at = clock.now()
        const queueDir = laneQueuePath(path)
        mkdirSync(queueDir, { recursive: true })
        ticket = join(queueDir, `${at}-${token}.json`)
        writeFileSync(ticket, `${JSON.stringify(stamp(at), null, 2)}\n`, { flag: 'wx' })
        continue
      }

      if (clock.now() >= deadline)
        throw new Error(
          `waited ${Math.round((clock.now() - startedAt) / 60_000)} minutes for the CS2 lane lock ` +
            `at ${path}, held by ${describeLaneLock(held)}` +
            (ahead.length > 0 ? `, behind ${describeLaneQueue(ahead)}` : '') +
            '. Break it with `node scripts/cs2-lane-lock.mjs break` if that run is gone.',
        )
      onWait({ held, broke: false, ahead, waitedMs: clock.now() - startedAt, path })
      await clock.sleep(Math.max(0, Math.min(pollMs, deadline - clock.now())))
    }
  } finally {
    // Taken or given up, the ticket goes: a lane that is ours is no longer
    // queued for, and a waiter that gave up must not hold its place.
    if (ticket !== null)
      try {
        unlinkSync(ticket)
      } catch {
        /* judged dead and removed by somebody else — nothing to do */
      }
  }
}

/** Who is queued, for the line a waiter and the `status` verb print. */
export function describeLaneQueue(queue) {
  if (queue.length === 0) return 'nobody queued'
  const first = `${queue[0].holder} (${queue[0].what || `pid ${queue[0].pid}`})`
  return queue.length === 1 ? `${first} queued` : `${first} and ${queue.length - 1} more queued`
}

// ---------------------------------------------------------------------------
// The two verbs an operator has
// ---------------------------------------------------------------------------

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const verb = process.argv[2] ?? 'status'
  const held = readLaneLock()
  if (verb === 'status') {
    const alive = held !== null && laneLockHolderLives(held)
    const queue = readLaneQueue(LANE_LOCK_PATH, { prune: false })
    process.stdout.write(
      held === null
        ? `the CS2 lane is free (${LANE_LOCK_PATH})\n`
        : `the CS2 lane is held by ${describeLaneLock(held)}${alive ? '' : ' — and that run is gone; `break` it'}\n`,
    )
    if (queue.length > 0) process.stdout.write(`${describeLaneQueue(queue)}\n`)
    process.exitCode = held === null ? 0 : 1
  } else if (verb === 'break') {
    if (held === null) process.stdout.write('the CS2 lane was already free\n')
    else {
      releaseLaneLock(LANE_LOCK_PATH, null)
      process.stdout.write(`took the CS2 lane away from ${describeLaneLock(held)}\n`)
    }
  } else {
    process.stderr.write(`usage: node scripts/cs2-lane-lock.mjs [status|break]\n`)
    process.exitCode = 2
  }
}
