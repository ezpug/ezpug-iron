/**
 * SHA-256 and HMAC-SHA256, synchronous, in plain TypeScript. The fake signs
 * every webhook and hashes every demo with these instead of `crypto.subtle`
 * for one reason: Web Crypto is asynchronous on a macrotask, and a fake that
 * must play a whole match inside `clock.runAll()` — and record the same
 * envelopes in the same order under the same seed — cannot let the order of
 * its facts depend on when the event loop gets around to a digest. The
 * published verifier (`webhooks/signature.ts`) stays on Web Crypto; a test
 * proves the two agree on the same inputs.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

const BLOCK_BYTES = 64

/** SHA-256 of `bytes`, as 32 bytes. */
export function sha256(bytes: Uint8Array): Uint8Array {
  const bitLength = bytes.byteLength * 8
  const paddedLength = Math.ceil((bytes.byteLength + 9) / BLOCK_BYTES) * BLOCK_BYTES
  const padded = new Uint8Array(paddedLength)
  padded.set(bytes)
  padded[bytes.byteLength] = 0x80
  const view = new DataView(padded.buffer)
  // The message length in bits, big-endian, in the last eight bytes; inputs
  // here are far below 2^32 bits, so the high word is zero.
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000))
  view.setUint32(paddedLength - 4, bitLength >>> 0)

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  const w = new Uint32Array(64)

  for (let offset = 0; offset < paddedLength; offset += BLOCK_BYTES) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4)
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15] as number
      const w2 = w[i - 2] as number
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3)
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10)
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) >>> 0
    }

    let [a, b, c, d, e, f, g, hh] = h as unknown as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ]
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const temp1 = (hh + S1 + ch + (K[i] as number) + (w[i] as number)) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (S0 + maj) >>> 0
      hh = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }
    h[0] = (h[0] as number) + a
    h[1] = (h[1] as number) + b
    h[2] = (h[2] as number) + c
    h[3] = (h[3] as number) + d
    h[4] = (h[4] as number) + e
    h[5] = (h[5] as number) + f
    h[6] = (h[6] as number) + g
    h[7] = (h[7] as number) + hh
  }

  const out = new Uint8Array(32)
  const outView = new DataView(out.buffer)
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i] as number)
  return out
}

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits))
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

/** SHA-256 of `bytes`, lowercase hex — the `sha256` a `demo.uploaded` fact carries. */
export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes))
}

const encoder = new TextEncoder()

/** HMAC-SHA256 of `payload` under `secret` (both UTF-8), lowercase hex — synchronous. */
export function hmacSha256HexSync(secret: string, payload: string): string {
  let key: Uint8Array = encoder.encode(secret)
  if (key.byteLength > BLOCK_BYTES) key = sha256(key)
  const padded = new Uint8Array(BLOCK_BYTES)
  padded.set(key)
  const inner = new Uint8Array(BLOCK_BYTES)
  const outer = new Uint8Array(BLOCK_BYTES)
  for (let i = 0; i < BLOCK_BYTES; i++) {
    inner[i] = (padded[i] as number) ^ 0x36
    outer[i] = (padded[i] as number) ^ 0x5c
  }
  const message = encoder.encode(payload)
  const innerInput = new Uint8Array(BLOCK_BYTES + message.byteLength)
  innerInput.set(inner)
  innerInput.set(message, BLOCK_BYTES)
  const innerHash = sha256(innerInput)
  const outerInput = new Uint8Array(BLOCK_BYTES + innerHash.byteLength)
  outerInput.set(outer)
  outerInput.set(innerHash, BLOCK_BYTES)
  return bytesToHex(sha256(outerInput))
}
