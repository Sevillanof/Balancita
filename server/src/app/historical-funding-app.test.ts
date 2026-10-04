import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildApp } from './app.ts'
import { serverConfigFrom } from '../platform/config.ts'
import { FuturesStore } from '../features/paper-futures/futures-store.ts'
import type { FuturesSocket } from '../features/kraken-futures/futures-market.ts'
import { FuturesMarketStore } from '../features/kraken-futures/futures-market-store.ts'

const capturedResponse = readFileSync(
  new URL(
    '../../../playwright-artifacts/futures-diagnostics/funding-current-20261003T225404Z/response.json',
    import.meta.url,
  ),
  'utf8',
)
const now = 1_790_950_000_000

describe('PAPER_LIVE historical funding integration', () => {
  it('persists source audit and delivers known absolute funding through the shared Python runtime', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'funding-app-integration-'))
    const marketPath = join(directory, 'market.sqlite')
    const accountPath = join(directory, 'account.sqlite')
    const socket: FuturesSocket = {
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      send: () => undefined,
      close: () => undefined,
    }
    let fundingFetched!: () => void
    const fundingReady = new Promise<void>((resolve) => {
      fundingFetched = resolve
    })
    const app = await buildApp({
      config: serverConfigFrom({
        FUTURES_MODE: 'paper_live',
        FUTURES_DB_PATH: accountPath,
        FUTURES_MARKET_DB_PATH: marketPath,
        KRAKEN_REST_OHLC_WORKER_ENABLED: 'false',
      }),
      overrides: {
        futuresPublicCatalog: async () => ({
          instruments: [
            {
              symbol: 'PF_XBTUSD',
              type: 'flexible_futures',
              pair: 'BTC:USD',
              base: 'BTC',
              quote: 'USD',
              contractSize: '1',
              tickSize: '1',
              contractValueTradePrecision: 4,
              tradeable: true,
              isExpired: false,
            },
          ],
        }),
        futuresSocketFactory: () => socket,
        futuresClock: () => now,
        futuresFundingFetch: async () => {
          fundingFetched()
          return new Response(capturedResponse, { status: 200 })
        },
      } as never,
    })
    try {
      await app.ready()
      await fundingReady
      await new Promise((resolve) => setTimeout(resolve, 50))
      socket.onopen?.()
      for (const message of [
        {
          feed: 'book_snapshot',
          product_id: 'PF_XBTUSD',
          seq: 10,
          timestamp: now,
          bids: [{ price: '90000', qty: '0.5' }],
          asks: [{ price: '90001', qty: '0.5' }],
        },
        {
          feed: 'ticker',
          product_id: 'PF_XBTUSD',
          seq: 20,
          time: now,
          last: '90000.5',
          markPrice: '90000',
          suspended: false,
        },
        {
          feed: 'book',
          product_id: 'PF_XBTUSD',
          seq: 11,
          timestamp: now + 100,
          side: 'buy',
          price: '90000',
          qty: '0.6',
        },
        {
          feed: 'trade',
          product_id: 'PF_XBTUSD',
          uid: 'funding-runtime-trade',
          side: 'sell',
          type: 'fill',
          seq: 31,
          time: now + 100,
          qty: '0.0002',
          price: '90000',
        },
      ])
        socket.onmessage?.({ data: JSON.stringify(message) })
      await new Promise((resolve) => setTimeout(resolve, 100))
    } finally {
      await app.close()
      const market = new FuturesMarketStore(marketPath)
      const evidence = market.fundingForInterval(now, now)
      expect(evidence.length).toBeGreaterThan(0)
      expect(
        market.fundingResponse(String(evidence[0]!.sha256))?.rawResponse,
      ).toBe(capturedResponse)
      market.close()

      const account = new FuturesStore(accountPath)
      const binding = account.getReplaySessionBinding(
        'futures-session:primary',
      )!
      expect((binding.manifest as Record<string, unknown>).source).toBe(
        'kraken-public-live-stream.v2',
      )
      const replay = account.loadReplaySession(
        'futures-session:primary',
        binding,
      )
      const expectedRate = String(evidence[0]!.fundingRate)
      expect(
        replay.works.some((work) => {
          const input = work.input as Record<string, unknown>
          const snapshot = (input.payload as Record<string, unknown>)
            .market_snapshot as Record<string, unknown>
          return (snapshot.events as Record<string, unknown>[]).some(
            (event) =>
              event.type === 'funding_observation' &&
              (event.observation as Record<string, unknown>).source ===
                'kraken-historical-funding-rates.v1' &&
              (event.observation as Record<string, unknown>).raw_rate ===
                expectedRate,
          )
        }),
      ).toBe(true)
      account.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
