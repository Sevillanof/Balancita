import { describe, expect, it } from 'vitest'
import { ServerConfigError, serverConfigFrom } from './config.ts'

describe('serverConfigFrom', () => {
  it('refuses to start when the retired FUTURES_MODE is set', () => {
    for (const mode of ['mock', 'paper_live', 'replay', 'anything'])
      expect(() => serverConfigFrom({ FUTURES_MODE: mode })).toThrow(
        ServerConfigError,
      )
    expect(() => serverConfigFrom({ FUTURES_MODE: 'paper_live' })).toThrow(
      /retirado.*retired.*pnpm run dev.*\.env/s,
    )
  })

  it('treats an empty FUTURES_MODE as unset and keeps the market DB path', () => {
    expect(serverConfigFrom({ FUTURES_MODE: '' })).toMatchObject({
      futuresMarketDbPath: './data/futures-market.sqlite',
    })
    expect(
      serverConfigFrom({ FUTURES_MARKET_DB_PATH: '/tmp/market.sqlite' })
        .futuresMarketDbPath,
    ).toBe('/tmp/market.sqlite')
  })

  it('has loopback defaults', () => {
    expect(serverConfigFrom({})).toMatchObject({
      host: '127.0.0.1',
      port: 8787,
      corsOrigin: 'http://localhost:5173',
      marketStaleAfterMs: 15_000,
      marketReconnectMinMs: 1_000,
      marketReconnectMaxMs: 30_000,
    })
  })

  it('rejects non-positive integers and an inverted reconnect window', () => {
    expect(() => serverConfigFrom({ PORT: '0' })).toThrow(ServerConfigError)
    expect(() => serverConfigFrom({ PORT: 'abc' })).toThrow(/PORT/)
    expect(() =>
      serverConfigFrom({
        MARKET_RECONNECT_MIN_MS: '5000',
        MARKET_RECONNECT_MAX_MS: '1000',
      }),
    ).toThrow(/MARKET_RECONNECT_MAX_MS/)
  })
})
