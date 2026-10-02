import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { itemVdf, parseWorkshopItem, publishedIdFromVdf, uploadVerdict } from '../src/workshop.ts'

const HUD = resolve(dirname(fileURLToPath(import.meta.url)), '..')

describe('hud/workshop.json', () => {
  it('describes an unlisted item, in German and English', () => {
    const item = parseWorkshopItem(readFileSync(join(HUD, 'workshop.json'), 'utf8'))
    expect(item.visibility).toBe('unlisted')
    expect(item.description).toMatch(/Server/)
    expect(item.description).toMatch(/subscribe/)
  })
})

describe('the item VDF', () => {
  const item = {
    publishedFileId: '',
    visibility: 'unlisted' as const,
    title: 'EZPug "HUD"',
    description: 'a\\b',
  }

  it('creates with title, description and visibility, escaped', () => {
    const vdf = itemVdf(item, '/work/content', 'abc1234: first')
    expect(vdf).toContain('"publishedfileid"\t\t"0"')
    expect(vdf).toContain('"visibility"\t\t"3"')
    expect(vdf).toContain('"title"\t\t"EZPug \\"HUD\\""')
    expect(vdf).toContain('"description"\t\t"a\\\\b"')
    expect(vdf).toContain('"changenote"\t\t"abc1234: first"')
    // SteamCMD fails every preview upload for app 730 (src/workshop.ts).
    expect(vdf).not.toContain('previewfile')
  })

  it('updates the content alone, leaving what was edited on the item page', () => {
    const vdf = itemVdf({ ...item, publishedFileId: '3812345678' }, '/work/content', 'n')
    expect(vdf).toContain('"publishedfileid"\t\t"3812345678"')
    expect(vdf).not.toMatch(/"title"|"description"|"visibility"/)
  })

  it('reads back the id SteamCMD writes into it', () => {
    expect(publishedIdFromVdf('"workshopitem"\n{\n\t"publishedfileid"\t\t"3812345678"\n}')).toBe(
      '3812345678',
    )
    expect(publishedIdFromVdf('"publishedfileid" "0"')).toBeUndefined()
  })
})

describe("SteamCMD's verdict", () => {
  it('knows a success', () => {
    expect(uploadVerdict('Uploading content...\nCommitting update...Success.\n')).toEqual({
      ok: true,
    })
  })

  it('knows one through the colours and an IPC warning in the middle of it', () => {
    // The item's update of 2026-10-02, as SteamCMD printed it.
    const transcript =
      'Uploading content...\x1b[0m.\x1b[0m.\x1b[0m\n' +
      'Committing update...\x1b[0mIPC function call IClientUGC::GetItemUpdateProgress took too long: 164 msec\n' +
      'Success.\x1b[0mUnloading Steam API...\x1b[0mOK\n' +
      '\x1b[0mCWorkThreadPool::~CWorkThreadPool: work processing queue not empty: 1 items discarded.\n'
    expect(uploadVerdict(transcript)).toEqual({ ok: true })
  })

  it('does not take a success from before the commit for one', () => {
    expect(uploadVerdict('Loading Steam API...OK\nSuccess.\nPreparing update...\n').ok).toBe(false)
  })

  it("names Steam's refusal", () => {
    expect(uploadVerdict('ERROR! Failed to update workshop item (Access Denied).')).toEqual({
      ok: false,
      reason: 'Access Denied',
    })
  })

  it('treats silence as a failure', () => {
    expect(uploadVerdict('Logging in...\n').ok).toBe(false)
  })
})
