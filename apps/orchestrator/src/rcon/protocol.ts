/**
 * **Source RCON, the wire** (PRD-02 T20). Valve's remote-console protocol is
 * four fields over TCP and is documented once, here, so the client below and
 * the fake server beside it cannot drift apart:
 *
 * ```text
 * int32 size   — bytes that follow this field
 * int32 id     — the caller's, echoed back; -1 means "authentication failed"
 * int32 type   — the four constants below
 * body         — ASCII, null-terminated
 * byte  0      — a second terminator the spec insists on
 * ```
 *
 * Everything is little-endian. `size` is `body.length + 10`.
 *
 * We wrote this rather than taking `rcon-client`: reading it, the package is
 * ~200 lines whose whole substance is this framing plus a `setTimeout` we are
 * not allowed to use (CLAUDE.md's determinism rule — every deadline in this
 * repo is on the injected clock). Vendoring the framing costs less than
 * wrapping a dependency whose timers we would have to fight.
 */

/** Client → server: here is the password. */
export const RCON_AUTH = 3
/** Server → client: the answer to an auth, `id: -1` when it failed. */
export const RCON_AUTH_RESPONSE = 2
/** Client → server: run this. Shares its number with {@link RCON_AUTH_RESPONSE} — direction disambiguates. */
export const RCON_EXECCOMMAND = 2
/** Server → client: a chunk of a command's output. Also the empty packet we bounce as an end marker. */
export const RCON_RESPONSE_VALUE = 0

/** The id a server sends when it will not talk to you. */
export const RCON_AUTH_FAILED_ID = -1

/** The longest packet we will read before deciding the peer is not an RCON server. */
export const RCON_PACKET_MAX = 4096 + 16

export interface RconPacket {
  id: number
  type: number
  body: string
}

export function encodeRconPacket(packet: RconPacket): Buffer {
  const body = Buffer.from(packet.body, 'ascii')
  const frame = Buffer.allocUnsafe(body.length + 14)
  frame.writeInt32LE(body.length + 10, 0)
  frame.writeInt32LE(packet.id, 4)
  frame.writeInt32LE(packet.type, 8)
  body.copy(frame, 12)
  frame.writeUInt8(0, body.length + 12)
  frame.writeUInt8(0, body.length + 13)
  return frame
}

/**
 * Pull every whole packet out of `buffered`, leaving the partial tail.
 * Throws when a length prefix is nonsense — a peer that is not RCON, or a
 * stream that lost its place; either way the connection is finished.
 */
export function decodeRconPackets(buffered: Buffer): { packets: RconPacket[]; rest: Buffer } {
  const packets: RconPacket[] = []
  let offset = 0
  while (buffered.length - offset >= 4) {
    const size = buffered.readInt32LE(offset)
    if (size < 10 || size > RCON_PACKET_MAX)
      throw new Error(`rcon: a packet claims ${size} bytes, which is not a packet`)
    if (buffered.length - offset - 4 < size) break
    const id = buffered.readInt32LE(offset + 4)
    const type = buffered.readInt32LE(offset + 8)
    // `size` counts id, type, the body and its two terminators.
    const body = buffered.toString('ascii', offset + 12, offset + 4 + size - 2)
    packets.push({ id, type, body })
    offset += 4 + size
  }
  return { packets, rest: buffered.subarray(offset) }
}
