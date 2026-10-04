import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type MarketDataEnvelope,
  type TimestampMs,
} from '../../domain/contracts.ts'
import {
  MarketStore,
  MarketStoreValidationError,
  type StoredMarketObservation,
} from './market-store.ts'
import type { NormalizedMarketPayload } from './market-payload.ts'

const tempDirectories: string[] = []

function makePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'balancita-market-store-'))
  tempDirectories.push(directory)
  return join(directory, 'market.sqlite')
}

function envelope(
  overrides: Partial<MarketDataEnvelope<NormalizedMarketPayload>> = {},
): MarketDataEnvelope<NormalizedMarketPayload> {
  return {
    source: 'kraken',
    symbol: 'BTC-EUR',
    instrumentId: 'BTC-EUR',
    eventTime: 1_000 as TimestampMs,
    receivedTime: 1_100 as TimestampMs,
    displayTime: 1_100 as TimestampMs,
    sequence: 10,
    payload: {
      type: 'ticker',
      productId: 'BTC-EUR',
      tradeId: 20,
      sequence: 10,
      price: 60_000,
    },
    status: 'live',
    freshness: { ageMs: 100, isStale: false, clockInverted: false },
    ...overrides,
  }
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('MarketStore', () => {
  it('uses WAL and a 5000ms busy timeout for persistent databases', () => {
    const path = makePath()
    const store = new MarketStore({ path })
    expect(store.sqliteSettings()).toEqual({
      journalMode: 'wal',
      busyTimeout: 5000,
    })
    store.close()
  })

  it('keeps in-memory stores usable with a 5000ms busy timeout', () => {
    const store = new MarketStore({ path: ':memory:' })
    expect(store.schemaVersion()).toBe(12)
    expect(store.sqliteSettings()).toEqual({
      journalMode: 'memory',
      busyTimeout: 5000,
    })
    store.close()
  })
  it('initializes the versioned schema at the injected path', () => {
    const store = new MarketStore({ path: makePath() })

    expect(store.schemaVersion()).toBe(12)
    expect(store.observationCount()).toBe(0)

    store.close()
  })

  it('migrates the v9 paper ledger and preserves strategy idempotency', () => {
    const path = makePath()
    const legacyDatabase = new DatabaseSync(path)
    legacyDatabase.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
      INSERT INTO schema_migrations VALUES (9, 1);
      CREATE TABLE paper_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        candidate_id TEXT NOT NULL,
        signal_timestamp INTEGER NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('BUY', 'SELL')),
        price REAL NOT NULL,
        quantity_btc REAL NOT NULL
      );
    `)
    legacyDatabase.close()
    const store = new MarketStore({ path })
    const database = new DatabaseSync(path)
    const columns = database
      .prepare('PRAGMA table_info(paper_orders)')
      .all() as {
      name: string
      notnull: number
    }[]
    expect(columns.map(({ name }) => name)).toEqual([
      'id',
      'strategy_id',
      'signal_timestamp',
      'execution_timestamp',
      'action',
      'price',
      'amount_eur',
      'fee_eur',
      'pnl_eur',
      'gate_passed',
      'target_pct',
      'created_at',
    ])
    expect(columns.find(({ name }) => name === 'price')?.notnull).toBe(1)
    const order = {
      strategyId: 'micro-donchian-breakout',
      signalTimestamp: 100,
      action: 'BUY' as const,
      gatePassed: false,
      price: 20_000,
      executionTimestamp: null,
      amountEur: 30,
      feeEur: 0,
      pnlEur: null,
      targetPct: 0.005,
    }
    expect(store.insertPaperOrder(order)).toBe(true)
    expect(store.insertPaperOrder(order)).toBe(false)
    expect(store.listPaperOrders()[0]).toMatchObject({
      strategyId: order.strategyId,
      price: 20_000,
      executionTimestamp: null,
    })
    expect(store.paperOrderSignalAggregates()).toEqual([
      {
        strategy_id: order.strategyId,
        total_signals: 1,
        gate_rejections: 1,
        executed_buys: 0,
        executed_sells: 0,
        total_fees_eur: 0,
        net_pnl_eur: 0,
        avg_target_pct: 0.005,
      },
    ])
    expect(
      database.prepare('SELECT gate_passed FROM paper_orders').get(),
    ).toEqual({ gate_passed: 0 })
    expect(
      database.prepare('SELECT created_at FROM paper_orders').get(),
    ).toMatchObject({ created_at: expect.any(String) })
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_paper_orders_strategy', 'idx_paper_orders_gate') ORDER BY name",
        )
        .all(),
    ).toEqual([
      { name: 'idx_paper_orders_gate' },
      { name: 'idx_paper_orders_strategy' },
    ])
    expect(
      database
        .prepare(
          'SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 10',
        )
        .get(),
    ).toEqual({ count: 1 })
    database.close()
    store.close()

    const reopened = new MarketStore({ path })
    expect(reopened.schemaVersion()).toBe(12)
    expect(reopened.listPaperOrders()).toHaveLength(1)
    reopened.close()
  })

  it('refuses to migrate a populated legacy v9 paper ledger without changing it', () => {
    const path = makePath()
    const database = new DatabaseSync(path)
    database.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
      INSERT INTO schema_migrations VALUES (9, 1);
      CREATE TABLE paper_orders (
        id INTEGER PRIMARY KEY, candidate_id TEXT NOT NULL, signal_timestamp INTEGER NOT NULL,
        action TEXT NOT NULL, price REAL NOT NULL, quantity_btc REAL NOT NULL
      );
      INSERT INTO paper_orders VALUES (1, 'legacy', 100, 'BUY', 20000, 0.001);
    `)
    database.close()

    expect(() => new MarketStore({ path })).toThrow(/paper_orders.*rows/i)

    const unchanged = new DatabaseSync(path)
    expect(
      unchanged
        .prepare('SELECT MAX(version) AS version FROM schema_migrations')
        .get(),
    ).toEqual({ version: 9 })
    expect(
      (
        unchanged.prepare('PRAGMA table_info(paper_orders)').all() as {
          name: string
        }[]
      ).map(({ name }) => name),
    ).toEqual([
      'id',
      'candidate_id',
      'signal_timestamp',
      'action',
      'price',
      'quantity_btc',
    ])
    expect(unchanged.prepare('SELECT * FROM paper_orders').get()).toEqual({
      id: 1,
      candidate_id: 'legacy',
      signal_timestamp: 100,
      action: 'BUY',
      price: 20000,
      quantity_btc: 0.001,
    })
    unchanged.close()
  })

  it('inserts closed OHLC batches atomically and ignores repeated timestamps', () => {
    const store = new MarketStore({ path: makePath() })
    const candles = [60, 120].map((timestamp) => ({
      timestamp,
      open: 10,
      high: 11,
      low: 9,
      close: 10,
      volume: 1,
    }))

    expect(store.insertOhlcCandles(candles)).toBe(2)
    expect(store.insertOhlcCandles(candles)).toBe(0)
    expect(store.ohlcCandleCount()).toBe(2)

    store.close()
  })

  it('returns only the latest contiguous candles at or before the epoch-ms cutoff', () => {
    const store = new MarketStore({ path: ':memory:' })
    const candles = [60, 120, 180, 300, 360, 420].map((timestamp) => ({
      timestamp,
      open: timestamp,
      high: timestamp + 1,
      low: timestamp - 1,
      close: timestamp,
      volume: 1,
    }))
    store.insertOhlcCandles(candles)

    expect(store.latestContinuousOhlcCandles(3, 360_000)).toEqual(
      candles.slice(3, 5),
    )
    store.close()
  })

  it('keeps the OHLC polling cursor and successful-sync time across store reopen', () => {
    const path = makePath()
    const first = new MarketStore({ path })
    first.saveOhlcCollectorState(123, 456_000)
    first.close()

    const reopened = new MarketStore({ path })
    expect(reopened.getOhlcCollectorState()).toEqual({
      cursor: 123,
      lastSuccessfulSync: 456_000,
    })
    reopened.close()
  })

  it('applies the current migration to an existing version-zero database', () => {
    const path = makePath()
    const database = new DatabaseSync(path)
    database.exec(
      'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)',
    )
    database.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(0, 1)
    database.close()

    const store = new MarketStore({ path })
    expect(store.schemaVersion()).toBe(12)
    expect(store.observationCount()).toBe(0)
    store.close()
  })

  it('migrates an existing market schema v1 to the forecast ledger schema v2', () => {
    const path = makePath()
    const database = new DatabaseSync(path)
    database.exec(
      'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)',
    )
    database.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(1, 1)
    database.close()

    const store = new MarketStore({ path })
    const migratedDatabase = new DatabaseSync(path)
    const ledgerTable = migratedDatabase
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'forecast_records'",
      )
      .get()
    migratedDatabase.close()
    expect(store.schemaVersion()).toBe(12)
    expect(ledgerTable).toEqual({ name: 'forecast_records' })
    store.close()
  })

  it('inserts a valid envelope and returns duplicate on exact replay', () => {
    const store = new MarketStore({ path: makePath() })
    const first = store.insertObservation(envelope())
    const replay = store.insertObservation(envelope())

    expect(first.outcome).toBe('inserted')
    expect(replay).toEqual({
      outcome: 'duplicate',
      id: first.id,
      contentHash: first.contentHash,
    })
    expect(store.observationCount()).toBe(1)

    store.close()
  })

  it('deduplicates a replay even when derived freshness changed at receipt time', () => {
    const store = new MarketStore({ path: makePath() })
    const first = store.insertObservation(envelope())
    const replay = store.insertObservation(
      envelope({
        receivedTime: 20_000 as TimestampMs,
        displayTime: 20_000 as TimestampMs,
        status: 'stale',
        freshness: { ageMs: 19_000, isStale: true, clockInverted: false },
      }),
    )

    expect(replay).toEqual({
      outcome: 'duplicate',
      id: first.id,
      contentHash: first.contentHash,
    })
    expect(store.observationCount()).toBe(1)
    store.close()
  })

  it('rejects unsupported instruments, invalid time ordering, and invalid payloads', () => {
    const store = new MarketStore({ path: makePath() })

    expect(() =>
      store.insertObservation(envelope({ symbol: 'ETH-EUR' as 'BTC-EUR' })),
    ).toThrow(MarketStoreValidationError)
    expect(() =>
      store.insertObservation(envelope({ receivedTime: 900 as TimestampMs })),
    ).toThrow(MarketStoreValidationError)
    expect(() =>
      store.insertObservation(
        envelope({ payload: { type: 'ticker', price: -1 } as never }),
      ),
    ).toThrow(MarketStoreValidationError)

    store.close()
  })

  it('keeps historical observations append-only', () => {
    const store = new MarketStore({ path: makePath() })
    store.insertObservation(envelope())
    store.insertObservation(
      envelope({
        eventTime: 2_000 as TimestampMs,
        receivedTime: 2_100 as TimestampMs,
        displayTime: 2_100 as TimestampMs,
        sequence: 11,
        payload: {
          type: 'ticker',
          productId: 'BTC-EUR',
          tradeId: 21,
          sequence: 11,
          price: 60_100,
        },
      }),
    )

    const observations: readonly StoredMarketObservation[] =
      store.listObservations()
    expect(observations).toHaveLength(2)
    expect(observations[0]?.payload).toEqual(envelope().payload)
    expect(observations[1]?.payload).toMatchObject({ price: 60_100 })

    store.close()
  })

  it('persists cursor and evidence-backed gaps across a store restart', () => {
    const path = makePath()
    const first = new MarketStore({ path })
    first.beginConnection('kraken', 'BTC-EUR')
    first.updateCursor({
      source: 'kraken',
      instrumentId: 'BTC-EUR',
      lastSequence: 11,
      lastTradeId: 21,
      status: 'live',
      lastEventTime: 2_000 as TimestampMs,
      freshnessAgeMs: 100,
    })
    first.recordGap({
      source: 'kraken',
      instrumentId: 'BTC-EUR',
      prevSequence: 21,
      currentSequence: 23,
      detectedAt: 2_100 as TimestampMs,
      evidence: { kind: 'trade_id', channel: 'heartbeat' },
    })
    first.close()

    const second = new MarketStore({ path })
    const cursor = second.getCursor('kraken', 'BTC-EUR')
    expect(cursor).toMatchObject({
      lastSequence: 11,
      lastTradeId: 21,
      connectionRevision: 1,
      schemaVersion: 10,
    })
    expect(second.listGaps()).toEqual([
      expect.objectContaining({
        prevSequence: 21,
        currentSequence: 23,
        evidence: { kind: 'trade_id', channel: 'heartbeat' },
      }),
    ])
    second.close()
  })
})
