import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { TimestampMs } from '../../domain/contracts.ts'
import { MarketStore } from '../market-data/market-store.ts'
import type { StoredMarketObservation } from '../market-data/market-store.ts'
import {
  KRAKEN_OBSERVATIONS_IMPORT_VERSION,
  freezeDatasetFromObservations,
  importReplayTradesFromObservations,
  mapObservationToReplayTrade,
  openLiveMarketDbReadOnly,
  readKrakenObservationRows,
} from './kraken-observation-import.ts'

const tempDirectories: string[] = []

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function makeTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'balancita-replay-import-'))
  tempDirectories.push(directory)
  return directory
}

function tradeObservation(
  tradeId: number,
  eventTime: number,
  overrides: Partial<StoredMarketObservation> = {},
): StoredMarketObservation {
  return {
    id: `kraken:BTC-EUR:hash-${tradeId}`,
    source: 'kraken',
    instrumentId: 'BTC-EUR',
    eventTime: eventTime as TimestampMs,
    receivedTime: (eventTime + 100) as TimestampMs,
    displayTime: (eventTime + 100) as TimestampMs,
    sequence: tradeId,
    status: 'live',
    payload: {
      type: 'trade',
      productId: 'BTC-EUR',
      tradeId,
      sequence: tradeId,
      price: 60_000 + tradeId,
      qty: 0.01,
      side: tradeId % 2 === 0 ? 'buy' : 'sell',
      orderType: 'limit',
    },
    freshnessAgeMs: 100,
    freshnessIsStale: false,
    contentHash: `hash-${tradeId}`,
    createdAt: (eventTime + 100) as TimestampMs,
    ...overrides,
  }
}

describe('kraken observation import', () => {
  it('maps a kraken trade observation to a ReplayTrade', () => {
    const trade = mapObservationToReplayTrade(
      tradeObservation(42, 1_700_000_001_000),
    )

    expect(trade).toMatchObject({
      instrumentId: 'BTC-EUR',
      source: 'kraken',
      tradeId: 42,
      eventTime: 1_700_000_001_000,
      receivedTime: 1_700_000_001_100,
      price: 60_042,
      qty: 0.01,
      side: 'buy',
      orderType: 'limit',
      origin: 'archive',
    })
  })

  it('skips non-trade payloads and non-kraken sources', () => {
    const ticker = tradeObservation(1, 1_000, {
      payload: {
        type: 'ticker',
        productId: 'BTC-EUR',
        tradeId: 1,
        sequence: 1,
        price: 60_001,
      },
    })
    const heartbeat = tradeObservation(2, 2_000, {
      payload: {
        type: 'heartbeat',
        productId: 'BTC-EUR',
        sequence: 2,
        lastTradeId: 1,
      },
    })
    const coinbase = tradeObservation(3, 3_000, { source: 'coinbase_exchange' })

    expect(mapObservationToReplayTrade(ticker)).toBeNull()
    expect(mapObservationToReplayTrade(heartbeat)).toBeNull()
    expect(mapObservationToReplayTrade(coinbase)).toBeNull()
    const imported = importReplayTradesFromObservations([
      ticker,
      heartbeat,
      coinbase,
    ])
    expect(imported.trades).toHaveLength(0)
    expect(imported.skipped).toBe(3)
  })

  it('dedupes byte-identical duplicate trade ids', () => {
    const first = tradeObservation(7, 1_000)
    const duplicate = tradeObservation(7, 1_000)
    const imported = importReplayTradesFromObservations([first, duplicate])

    expect(imported.trades).toHaveLength(1)
    expect(imported.duplicateCount).toBe(1)
    expect(imported.conflicts).toHaveLength(0)
  })

  it('fails closed on conflicting duplicates for the same trade id', () => {
    const first = tradeObservation(7, 1_000)
    const conflicting = tradeObservation(7, 1_000, {
      payload: {
        type: 'trade',
        productId: 'BTC-EUR',
        tradeId: 7,
        sequence: 7,
        price: 999_999,
        qty: 0.01,
        side: 'buy',
        orderType: 'limit',
      },
    })
    const imported = importReplayTradesFromObservations([first, conflicting])

    expect(imported.conflicts).toHaveLength(1)
    expect(() => freezeDatasetFromObservations([first, conflicting])).toThrow(
      expect.objectContaining({ code: 'conflicting_duplicate' }),
    )
  })

  it('fails closed on unresolved trade-id gaps, never silently skipping', () => {
    const observations = [
      tradeObservation(100, 1_700_000_001_000),
      tradeObservation(102, 1_700_000_004_000),
    ]
    const imported = importReplayTradesFromObservations(observations)

    expect(imported.gaps).toHaveLength(1)
    expect(imported.gaps[0]).toMatchObject({
      kind: 'trade_id',
      previousTradeId: 100,
      nextTradeId: 102,
      missingTradeIds: [101],
      resolved: false,
    })
    expect(() => freezeDatasetFromObservations(observations)).toThrow(
      expect.objectContaining({ code: 'unresolved_gap' }),
    )
  })

  it('supports since/until windows without flagging the cut edges as gaps', () => {
    const observations = [
      tradeObservation(100, 1_000),
      tradeObservation(101, 61_000),
      tradeObservation(102, 121_000),
      tradeObservation(103, 181_000),
    ]
    const imported = importReplayTradesFromObservations(observations, {
      since: 61_000 as TimestampMs,
      until: 121_000 as TimestampMs,
    })

    expect(imported.trades.map((trade) => trade.tradeId)).toEqual([101, 102])
    expect(imported.gaps).toHaveLength(0)
  })

  it('excludes future trades past asOfTimestamp (no look-ahead)', () => {
    const minute = 1_789_984_800_000
    const observations = [
      tradeObservation(100, minute + 10_000),
      tradeObservation(101, minute + 40_000),
      tradeObservation(102, minute + 60_000 + 10_000),
      tradeObservation(103, minute + 60_000 + 40_000),
    ]
    const dataset = freezeDatasetFromObservations(observations, {
      asOfTimestamp: (minute + 60_000) as TimestampMs,
    })

    expect(dataset.candles).toHaveLength(1)
    expect(dataset.candles[0]).toMatchObject({
      firstTradeId: 100,
      lastTradeId: 101,
    })
  })

  it('freezes contiguous trades with the kraken observations import version', () => {
    const minute = 1_789_984_800_000
    const observations = [
      tradeObservation(100, minute + 10_000),
      tradeObservation(101, minute + 40_000),
      tradeObservation(102, minute + 60_000 + 10_000),
      tradeObservation(103, minute + 60_000 + 40_000),
    ]
    const dataset = freezeDatasetFromObservations(observations, {
      asOfTimestamp: (minute + 2 * 60_000) as TimestampMs,
    })

    expect(dataset.importVersion).toBe(KRAKEN_OBSERVATIONS_IMPORT_VERSION)
    expect(dataset.importVersion).toBe('kraken-observations.v1')
    expect(dataset.interval).toBe('1m')
    expect(dataset.candles).toHaveLength(2)
  })

  it('opens the live database read-only via the injected opener', () => {
    const calls: Array<{ path: string; options: { readOnly: boolean } }> = []
    const fakeDb = {} as DatabaseSync
    const db = openLiveMarketDbReadOnly(
      '/live/market.sqlite',
      (path, options) => {
        calls.push({ path, options })
        return fakeDb
      },
    )

    expect(db).toBe(fakeDb)
    expect(calls).toEqual([
      { path: '/live/market.sqlite', options: { readOnly: true } },
    ])
  })

  it('reads kraken rows read-only and rejects writes on the handle', () => {
    const directory = makeTempDir()
    const marketPath = join(directory, 'market.sqlite')
    const store = new MarketStore({ path: marketPath })
    store.insertObservation({
      source: 'kraken',
      symbol: 'BTC-EUR',
      instrumentId: 'BTC-EUR',
      eventTime: 1_000 as TimestampMs,
      receivedTime: 1_100 as TimestampMs,
      displayTime: 1_100 as TimestampMs,
      sequence: 10,
      payload: {
        type: 'trade',
        productId: 'BTC-EUR',
        tradeId: 10,
        sequence: 10,
        price: 60_000,
        qty: 0.02,
        side: 'sell',
        orderType: 'market',
      },
      status: 'live',
      freshness: { ageMs: 100, isStale: false, clockInverted: false },
    })
    store.close()
    const before = statSync(marketPath)

    const db = openLiveMarketDbReadOnly(marketPath)
    const rows = readKrakenObservationRows(db, {})
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ source: 'kraken', instrumentId: 'BTC-EUR' })
    expect(() =>
      db.exec('CREATE TABLE probe_write (id INTEGER PRIMARY KEY)'),
    ).toThrow()
    db.close()

    const after = statSync(marketPath)
    expect(after.size).toBe(before.size)
    expect(after.mtimeMs).toBe(before.mtimeMs)
  })
})
