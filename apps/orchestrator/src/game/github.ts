import type { Clock } from '@ezpug/core'
import type { Log } from '../log'
import { type FetchLike, fetchBounded, GAME_FEED_TIMEOUT_MS, githubHeaders } from './feeds'

/**
 * **One GitHub issue per build** (PRD-10 T2): created on `game.build_moved`,
 * commented on every verdict and every upstream release it waits for, never
 * a second issue. The REST API with `EZPUG_IRON_GITHUB_TOKEN`; without the
 * token the door is closed and says so once per fact (`no issue filed: no
 * EZPUG_IRON_GITHUB_TOKEN`) — a dev box files nothing, and the fact and the
 * health move all the same.
 *
 * The token is the account: it is put on a request here and appears in no
 * log line, no fact, no issue body and no thrown error.
 */
export interface GitHubIssues {
  /** False without a token: every call below is a no-op that answers null. */
  readonly enabled: boolean
  readonly repo: string
  create: (issue: {
    title: string
    body: string
  }) => Promise<{ number: number; url: string } | null>
  comment: (number: number, body: string) => Promise<boolean>
}

export interface GitHubIssuesOptions {
  fetch: FetchLike
  clock: Clock
  log: Log
  /** `EZPUG_IRON_GITHUB_TOKEN`, or null. */
  token: string | null
  /** `owner/repo` — `EZPUG_IRON_GITHUB_REPO`, default {@link DEFAULT_GITHUB_REPO}. */
  repo: string
  /** GitHub's REST origin; the fake feeds' in a test. */
  apiUrl: string
  timeoutMs?: number
}

export const DEFAULT_GITHUB_REPO = 'ezpug/ezpug-iron'

/** What the log says when a fact would have filed an issue and no token is set. */
export const NO_TOKEN_LINE = 'no issue filed: no EZPUG_IRON_GITHUB_TOKEN'

function failureText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 256)
}

export function createGitHubIssues(options: GitHubIssuesOptions): GitHubIssues {
  const { fetch: fetchImpl, clock, log, token, repo, apiUrl } = options
  const timeoutMs = options.timeoutMs ?? GAME_FEED_TIMEOUT_MS
  const enabled = token !== null

  const post = async (path: string, body: unknown): Promise<Response> => {
    const response = await fetchBounded(
      fetchImpl,
      clock,
      `${apiUrl}${path}`,
      {
        method: 'POST',
        headers: { ...githubHeaders(token), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      timeoutMs,
    )
    if (!response.ok) throw new Error(`GitHub answered ${response.status} on POST ${path}`)
    return response
  }

  return {
    enabled,
    repo,
    async create(issue) {
      if (!enabled) {
        log.info(`game: ${NO_TOKEN_LINE} (would have filed "${issue.title}" on ${repo})`)
        return null
      }
      try {
        const response = await post(`/repos/${repo}/issues`, issue)
        const created = (await response.json()) as { number?: number; html_url?: string }
        if (typeof created.number !== 'number' || !created.html_url)
          throw new Error('GitHub answered an issue without a number')
        log.info(`game: filed ${created.html_url} ("${issue.title}")`)
        return { number: created.number, url: created.html_url }
      } catch (error) {
        log.error(`game: could not file "${issue.title}" on ${repo}`, failureText(error))
        return null
      }
    },
    async comment(number, body) {
      if (!enabled) {
        log.info(`game: ${NO_TOKEN_LINE} (would have commented on ${repo}#${number})`)
        return false
      }
      try {
        await post(`/repos/${repo}/issues/${number}/comments`, { body })
        return true
      } catch (error) {
        log.error(`game: could not comment on ${repo}#${number}`, failureText(error))
        return false
      }
    },
  }
}
