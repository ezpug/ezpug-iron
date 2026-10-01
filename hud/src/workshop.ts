/**
 * **The one Workshop item** (PRD-07 T1). `hud/workshop.json` is its committed
 * description; SteamCMD's `workshop_build_item` takes it as a VDF. What comes
 * back is read from SteamCMD's transcript, which the build container hands out
 * with the account's name and SteamID already removed.
 */

/** Steam's own numbers for `visibility` in an item VDF. */
export const VISIBILITY = { public: 0, 'friends-only': 1, private: 2, unlisted: 3 } as const
export type Visibility = keyof typeof VISIBILITY

export interface WorkshopItem {
  /** Empty until the first publish creates the item. */
  publishedFileId: string
  visibility: Visibility
  title: string
  description: string
}

export function parseWorkshopItem(text: string): WorkshopItem {
  const item = JSON.parse(text) as WorkshopItem
  if (typeof item.publishedFileId !== 'string' || !/^\d*$/.test(item.publishedFileId))
    throw new Error('hud/workshop.json: publishedFileId is a string of digits, or empty')
  if (!(item.visibility in VISIBILITY))
    throw new Error(`hud/workshop.json: visibility ${item.visibility}`)
  if (!item.title || item.title.length > 128)
    throw new Error('hud/workshop.json: a title of 1 to 128 characters')
  if (item.description.length > 8000)
    throw new Error('hud/workshop.json: the description is over 8000 characters')
  return item
}

const quote = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

/** The VDF `workshop_build_item` reads. Title, description and visibility go along only when creating. */
export function itemVdf(
  item: WorkshopItem,
  paths: { contentFolder: string; previewFile: string },
  changeNote: string,
): string {
  const fields: [string, string][] = [
    ['appid', '730'],
    ['publishedfileid', item.publishedFileId || '0'],
    ['contentfolder', paths.contentFolder],
    ['previewfile', paths.previewFile],
  ]
  if (!item.publishedFileId)
    fields.push(
      ['visibility', String(VISIBILITY[item.visibility])],
      ['title', item.title],
      ['description', item.description],
    )
  fields.push(['changenote', changeNote])
  return `"workshopitem"\n{\n${fields.map(([k, v]) => `\t${quote(k)}\t\t${quote(v)}`).join('\n')}\n}\n`
}

/** The id SteamCMD writes back into the VDF after creating an item. */
export function publishedIdFromVdf(vdf: string): string | undefined {
  const id = vdf.match(/"publishedfileid"\s+"(\d+)"/)?.[1]
  return id && id !== '0' ? id : undefined
}

export type UploadVerdict = { ok: true } | { ok: false; reason: string }

/** What SteamCMD said about an upload. Steam's own result word when it refused. */
export function uploadVerdict(transcript: string): UploadVerdict {
  const refused = transcript.match(/ERROR!?[^\n(]*\(([^)\n]+)\)/)
  if (refused) return { ok: false, reason: refused[1]! }
  if (/Committing update\.*\s*Success|^\s*Success\.\s*$/im.test(transcript)) return { ok: true }
  const last = transcript.trim().split('\n').slice(-3).join(' / ')
  return { ok: false, reason: `no success line from SteamCMD (it ended: ${last})` }
}
