import { describe, expect, it } from 'vitest'
import {
  feedUrls,
  GAME_FEED_URLS,
  parsePatchVersion,
  rateLimitResetOf,
  versionOfMetamodDrop,
  versionOfTag,
} from './feeds'

/**
 * The readings, parsed (PRD-10 T2). The bodies are what the real feeds
 * answered on 2026-10-24 — `feeds.ts`'s note on which number is which.
 */
describe('the feeds', () => {
  it('reads the PatchVersion out of Valve’s message, and nothing out of a message without one', () => {
    expect(parsePatchVersion('Server version required: 1.41.9.2')).toBe('1.41.9.2')
    expect(parsePatchVersion('Server version required: 1.42.0.0')).toBe('1.42.0.0')
    expect(parsePatchVersion('Your server is up to date')).toBeNull()
    expect(parsePatchVersion(undefined)).toBeNull()
  })

  it('reads a version off a release tag, with or without its v', () => {
    expect(versionOfTag('v1.0.378')).toBe('1.0.378')
    expect(versionOfTag('1.7')).toBe('1.7')
    expect(versionOfTag('v1.4.32-ezpug.1')).toBe('1.4.32-ezpug.1')
    expect(versionOfTag('version-1')).toBe('version-1')
  })

  it('reads a Metamod build off the drop’s file name', () => {
    expect(versionOfMetamodDrop('mmsource-2.0.0-git1483-linux.tar.gz\n')).toBe('2.0.0-git1483')
    expect(versionOfMetamodDrop('mmsource-2.0.0-git1483-windows.zip')).toBeNull()
    expect(versionOfMetamodDrop('<html>')).toBeNull()
  })

  it('rebases every feed onto one origin, keeping its path, and leaves the real world alone', () => {
    expect(feedUrls(null)).toBe(GAME_FEED_URLS)
    const urls = feedUrls('http://127.0.0.1:4567/')
    expect(urls.steamUpToDateCheck).toBe(
      'http://127.0.0.1:4567/ISteamApps/UpToDateCheck/v1?appid=730&version=0',
    )
    expect(urls.steamcmd).toBe('http://127.0.0.1:4567/v1/info/730')
    expect(urls.githubApi).toBe('http://127.0.0.1:4567')
    expect(urls.metamodDrop).toBe('http://127.0.0.1:4567/mmsdrop/2.0/mmsource-latest-linux')
  })

  it('reads GitHub’s rate limit off the headers it really sends, and nothing off another refusal', () => {
    const now = Date.parse('2026-10-24T12:00:00Z')
    const limited = new Response('', {
      status: 403,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1792929600' },
    })
    expect(rateLimitResetOf(limited, now)).toBe(1792929600 * 1000)
    const retry = new Response('', { status: 429, headers: { 'retry-after': '120' } })
    expect(rateLimitResetOf(retry, now)).toBe(now + 120_000)
    expect(rateLimitResetOf(new Response('', { status: 429 }), now)).toBe(now + 60 * 60_000)
    expect(rateLimitResetOf(new Response('', { status: 403 }), now)).toBeNull()
    expect(rateLimitResetOf(new Response('', { status: 404 }), now)).toBeNull()
  })
})
