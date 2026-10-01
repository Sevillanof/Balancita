import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MarketStore } from '../market-data/market-store.ts'
import { PaperForwardService } from './paper-forward.ts'

describe('paper decision events', () => {
  it('keeps prospective evaluations durable and leaves paper orders unchanged', () => {
    const directory = mkdtempSync(join(tmpdir(), 'balancita-decisions-'))
    const path = join(directory, 'market.sqlite')
    try {
      let store = new MarketStore({ path })
      const service = new PaperForwardService({
        store,
        clock: () => 1_700_000_000_000,
      })
      const start = Math.floor(1_700_000_100 / 900) * 900
      for (let index = 0; index < 765; index += 1) {
        const breakout = index >= 750
        service.processClosedCandle({
          timestamp: start + index * 60,
          open: 100,
          high: breakout ? 103 : 101,
          low: 99,
          close: breakout ? 102 : 100,
          volume: breakout && index === 764 ? 1_000 : 10,
        })
      }

      const first = store.listPaperDecisions({ limit: 100 })
      expect(first.length).toBeGreaterThan(0)
      expect(first[0]).toMatchObject({
        instrumentId: 'BTC-EUR',
        eventTime: expect.any(Number),
        receivedAt: 1_700_000_000_000,
        strategyId: expect.any(String),
        strategyVersion: expect.any(String),
        direction: expect.any(String),
        reason: null,
        reasonCode: expect.any(String),
        sessionId: expect.any(String),
        conditions: expect.arrayContaining([
          expect.objectContaining({
            code: expect.any(String),
            value: expect.anything(),
            operator: expect.any(String),
            threshold: expect.anything(),
            passed: expect.any(Boolean),
          }),
        ]),
      })
      const ordersBeforeClose = store.listPaperOrders()
      store.close()
      store = new MarketStore({ path })
      expect(store.listPaperDecisions({ limit: 100 })).toEqual(first)
      expect(store.listPaperOrders()).toEqual(ordersBeforeClose)
      store.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('deduplicates the same evaluation when a new service instance reprocesses the bucket', () => {
    const store = new MarketStore({ path: ':memory:' })
    const start = Math.floor(1_700_000_100 / 900) * 900
    const primary = new PaperForwardService({
      store,
      clock: () => 1_700_000_000_000,
    })
    const history = Array.from({ length: 765 }, (_, index) => ({
      timestamp: start + index * 60,
      open: 100,
      high: index >= 750 ? 103 : 101,
      low: 99,
      close: index >= 750 ? 102 : 100,
      volume: index === 764 ? 1_000 : 10,
    }))
    for (const candle of history.slice(0, 750))
      primary.processClosedCandle(candle)
    const restarted = new PaperForwardService({
      store,
      clock: () => 1_700_000_100_000,
    })
    const bucket = history.slice(750)
    for (const candle of bucket) primary.processClosedCandle(candle)
    const firstPass = store.listPaperDecisions({ limit: 100 })
    const orders = store.listPaperOrders()
    for (const candle of bucket) restarted.processClosedCandle(candle)

    expect(store.listPaperDecisions({ limit: 100 })).toEqual(firstPass)
    expect(store.listPaperOrders()).toEqual(orders)
    store.close()
  })

  it('migrates schema v11 decisions additively without backfilling rationale', () => {
    const directory = mkdtempSync(join(tmpdir(), 'balancita-decisions-v11-'))
    const path = join(directory, 'market.sqlite')
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO schema_migrations VALUES (11, 1);
      CREATE TABLE paper_decision_events (
        id TEXT PRIMARY KEY,
        instrument_id TEXT NOT NULL CHECK (instrument_id = 'BTC-EUR'),
        event_time INTEGER NOT NULL,
        received_at INTEGER NOT NULL,
        strategy_id TEXT NOT NULL,
        strategy_version TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('flat', 'long')),
        outcome TEXT NOT NULL CHECK (outcome IN ('abstained', 'gate-rejected', 'pending', 'hold')),
        reason TEXT,
        conditions_json TEXT NOT NULL
      ) STRICT;
      INSERT INTO paper_decision_events VALUES (
        'legacy-v11', 'BTC-EUR', 1000, 1010, 'micro-trend-pullback',
        'simulation-micro-trend-pullback-15m.v1', 'flat', 'hold', NULL, '[]'
      );
    `)
    legacy.close()

    const store = new MarketStore({ path })
    expect(store.schemaVersion()).toBe(12)
    expect(store.listPaperDecisions()).toEqual([
      {
        id: 'legacy-v11',
        instrumentId: 'BTC-EUR',
        eventTime: 1000,
        receivedAt: 1010,
        strategyId: 'micro-trend-pullback',
        strategyVersion: 'simulation-micro-trend-pullback-15m.v1',
        direction: 'flat',
        outcome: 'hold',
        reason: null,
        reasonCode: null,
        sessionId: null,
        conditions: [],
      },
    ])
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
})
