import * as api from '@ezpug/match-api'
import { describe, expect, it } from 'vitest'
import {
  WIDGET_CLOSE_CODES,
  WIDGET_HOST_PROTOCOL,
  WIDGET_SOCKET_PATH,
  WIDGET_SOCKET_PROTOCOL,
} from './protocol'

describe('the mirrored constants', () => {
  it('are the package’s, value for value', () => {
    expect(WIDGET_SOCKET_PATH).toBe(api.WIDGET_SOCKET_PATH)
    expect(WIDGET_SOCKET_PROTOCOL).toBe(api.WIDGET_SOCKET_PROTOCOL)
    expect(WIDGET_HOST_PROTOCOL).toBe(api.WIDGET_HOST_PROTOCOL)
    expect(WIDGET_CLOSE_CODES).toEqual(api.WIDGET_CLOSE_CODES)
  })
})
