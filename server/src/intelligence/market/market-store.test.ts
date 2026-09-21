import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { type MarketDataEnvelope, type TimestampMs } from '../contracts.ts'
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
    source: 'coinbase_exchange',
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
  it('initializes the versioned schema at the injected path', () => {
    const store = new MarketStore({ path: makePath() })

    expect(store.schemaVersion()).toBe(3)
    expect(store.observationCount()).toBe(0)

    store.close()
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
    expect(store.schemaVersion()).toBe(3)
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
    expect(store.schemaVersion()).toBe(3)
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
    first.beginConnection('coinbase_exchange', 'BTC-EUR')
    first.updateCursor({
      source: 'coinbase_exchange',
      instrumentId: 'BTC-EUR',
      lastSequence: 11,
      lastTradeId: 21,
      status: 'live',
      lastEventTime: 2_000 as TimestampMs,
      freshnessAgeMs: 100,
    })
    first.recordGap({
      source: 'coinbase_exchange',
      instrumentId: 'BTC-EUR',
      prevSequence: 21,
      currentSequence: 23,
      detectedAt: 2_100 as TimestampMs,
      evidence: { kind: 'trade_id', channel: 'heartbeat' },
    })
    first.close()

    const second = new MarketStore({ path })
    const cursor = second.getCursor('coinbase_exchange', 'BTC-EUR')
    expect(cursor).toMatchObject({
      lastSequence: 11,
      lastTradeId: 21,
      connectionRevision: 1,
      schemaVersion: 3,
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
