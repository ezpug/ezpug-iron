// Two known live-page violations: a session taken away from a document that is
// still mounted, which is what strands a background read into a console `401`.

declare const apiBaseUrl: string
declare const page: { request: { post: (url: string) => Promise<{ status: () => number }> } }
declare const person: { page: typeof page }
declare const request: { post: (url: string) => Promise<{ status: () => number }> }
declare function handBack(page: unknown): Promise<number>

export async function stranded(): Promise<void> {
  await page.request.post(`${apiBaseUrl}/auth/sign-out`)
  await person.page.request.post(`${apiBaseUrl}/auth/sign-out`).catch(() => null)
}

/** The shape the guard asks for, plus the two shapes it must leave alone. */
export async function tidy(): Promise<void> {
  // The browser leaves first, so there is nothing left to surprise.
  await handBack(page)
  // A bare `APIRequestContext` has no live document to strand.
  await request.post(`${apiBaseUrl}/auth/sign-out`)
  // And any other route on a page's own client is nobody's session.
  await page.request.post(`${apiBaseUrl}/admin/rooms/abc/close`)
}
