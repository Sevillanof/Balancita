import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildApp } from './app.ts'
import { MarketStore } from '../features/market-data/market-store.ts'
import { serverConfigFrom } from '../platform/config.ts'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

describe('paper decisions API', () => {
  it('returns persisted decision evidence with bounded pagination and validates queries', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'balancita-decision-api-'))
    directories.push(directory)
    const store = new MarketStore({ path: join(directory, 'market.sqlite') })
    store.insertPaperDecision({
      id: 'session-a:strategy:2000',
      instrumentId: 'BTC-EUR',
      eventTime: 2_000_000,
      receivedAt: 2_000_010,
      strategyId: 'micro-trend-pullback',
      strategyVersion: 'strategy-rule.v2',
      direction: 'long',
      outcome: 'gate-rejected',
      reasonCode: 'entry_gate_rejected',
      sessionId: 'runtime-a',
      reason: null,
      conditions: [
        {
          code: 'entry_gate_distance',
          value: 0.004,
          operator: '>=',
          threshold: 0.006,
          passed: false,
        },
      ],
    })
    store.insertPaperDecision({
      id: 'session-b:strategy:2000',
      instrumentId: 'BTC-EUR',
      eventTime: 2_000_000,
      receivedAt: 2_000_010,
      strategyId: 'micro-trend-pullback',
      strategyVersion: 'strategy-rule.v2',
      direction: 'flat',
      outcome: 'hold',
      reasonCode: 'exit_conditions_not_met',
      sessionId: 'runtime-b',
      reason: null,
      conditions: [],
    })
    const app = await buildApp({
      config: serverConfigFrom({
        MARKET_COLLECTOR_ENABLED: 'false',
        GEMINI_SERVER_CORS_ORIGIN: '',
      }),
      overrides: { marketStore: store },
    })
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/paper-trading/decisions?limit=1&strategy_id=micro-trend-pullback',
      })
      expect(response.statusCode).toBe(200)
      expect(response.json().decisions).toMatchObject([
        {
          id: 'session-b:strategy:2000',
          eventTime: 2_000_000,
          receivedAt: 2_000_010,
          direction: 'flat',
          outcome: 'hold',
          reasonCode: 'exit_conditions_not_met',
          sessionId: 'runtime-b',
          reason: null,
          conditions: [],
        },
      ])
      const cursor = response.json().nextCursor as {
        before: number
        before_id: string
      }
      const nextPage = await app.inject({
        method: 'GET',
        url: `/api/paper-trading/decisions?limit=1&before=${cursor.before}&before_id=${encodeURIComponent(cursor.before_id)}`,
      })
      expect(nextPage.json().decisions[0].id).toBe('session-a:strategy:2000')
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/api/paper-trading/decisions?limit=0',
          })
        ).statusCode,
      ).toBe(400)
    } finally {
      await app.close()
    }
  })
})
