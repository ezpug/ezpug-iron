// Three known PWA-boundary violations: a socket library, the realtime
// package's server door, and a server-side workspace package. Each is the
// companion growing code it may not author (PWA.md §1) — the door for the
// first two is `@ezpug/realtime/client`, and the third is a question for the
// typed API client.

import { createDatabase } from '@ezpug/db'
import { createChannelHub } from '@ezpug/realtime/server'
import { io } from 'socket.io-client'

export function grow(): void {
  void io('http://localhost:3410')
  void createChannelHub
  void createDatabase
}
