import { describe, expect, it } from 'vitest'
import { hmacSha256Hex } from '../webhooks/signature'
import { hmacSha256HexSync, sha256Hex } from './sha256'

const encoder = new TextEncoder()

describe('the fake’s synchronous digests', () => {
  it('computes the SHA-256 test vectors', () => {
    expect(sha256Hex(new Uint8Array(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
    expect(sha256Hex(encoder.encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    // Two blocks, with the length straddling the padding boundary.
    expect(
      sha256Hex(encoder.encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')),
    ).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1')
  })

  it('hashes a payload the size of a demo the same way the platform’s subtle digest does', async () => {
    const bytes = encoder.encode('x'.repeat(100_003))
    const expected = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b =>
      b.toString(16).padStart(2, '0'),
    ).join('')
    expect(sha256Hex(bytes)).toBe(expected)
  })

  it('agrees with the published Web Crypto HMAC for short and over-block keys', async () => {
    for (const secret of ['whsec-fake-0123456789abcdef0123456789abcdef', 'k'.repeat(200)]) {
      const payload = '1767225600.{"deliveryId":"x"}'
      expect(hmacSha256HexSync(secret, payload)).toBe(await hmacSha256Hex(secret, payload))
    }
  })
})
