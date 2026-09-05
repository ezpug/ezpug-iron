import { describe, expect, it } from 'vitest'
import { createMatchApiClient } from './index'

describe('createMatchApiClient', () => {
  it('is typed from the route table and sends the key as a bearer', async () => {
    let url = ''
    let auth: string | null = null
    const client = createMatchApiClient({
      baseUrl: 'https://gs.ezpug.example',
      apiKey: 'ezk_fake_platform_key',
      fetch: async (input, init) => {
        url = String(input)
        auth = new Headers(init?.headers).get('authorization')
        return new Response(JSON.stringify({ gamemodes: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    })
    const catalog = await client.gamemodes.list()
    expect(catalog.gamemodes).toEqual([])
    expect(url).toBe('https://gs.ezpug.example/v1/gamemodes')
    expect(auth).toBe('Bearer ezk_fake_platform_key')
  })
})
