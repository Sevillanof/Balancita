import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TimestampMs } from '../contracts.ts'
import { freezeReplayDataset } from './replay-dataset.ts'
import { ReplayDatasetStore } from './replay-dataset-store.ts'
import {
  ReplayDatasetFreezeError,
  type BackfillConflictEvidence,
  type BackfillGapEvidence,
  type ReplayTrade,
} from './replay-contracts.ts'

const T0 = 1_789_984_800_000
const CLOCK = T0 + 999_000
const directories: string[] = []

function makePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'balancita-replay-dataset-'))
  directories.push(directory)
  return join(directory, 'replay.sqlite')
}

function trade(input: {
  tradeId: number
  eventTime: number
  price: number
  qty?: number
  receivedTime?: number
}): ReplayTrade {
  return {
    instrumentId: 'BTC-EUR',
    source: 'kraken',
    tradeId: input.tradeId,
    eventTime: input.eventTime as TimestampMs,
    receivedTime: (input.receivedTime ?? CLOCK) as TimestampMs,
    price: input.price,
    qty: input.qty ?? 0.5,
    side: 'buy',
    orderType: 'limit',
    origin: 'archive',
  }
}

const closedTrades: readonly ReplayTrade[] = [
  trade({ tradeId: 200, eventTime: T0 + 10_000, price: 100 }),
  trade({ tradeId: 201, eventTime: T0 + 40_000, price: 101 }),
  trade({ tradeId: 202, eventTime: T0 + 70_000, price: 102 }),
  trade({ tradeId: 203, eventTime: T0 + 80_000, price: 103 }),
]

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

describe('frozen replay dataset', () => {
  it('keeps only closed candles and drops the still-open last candle', () => {
    const dataset = freezeReplayDataset({
      interval: '1m',
      importVersion: 'kraken-time-and-sales.v1',
      trades: closedTrades,
      gaps: [],
      conflicts: [],
    })

    expect(dataset.instrumentId).toBe('BTC-EUR')
    expect(dataset.source).toBe('kraken')
    expect(dataset.asOfTimestamp).toBe(T0 + 80_000)
    expect(dataset.candles).toHaveLength(1)
    expect(dataset.candles.every((candle) => candle.isClosed)).toBe(true)
    expect(dataset.candles[0]).toMatchObject({
      bucketStart: T0,
      bucketEnd: T0 + 60_000,
      open: 100,
      high: 101,
      low: 100,
      close: 101,
      tradeCount: 2,
      firstTradeId: 200,
      lastTradeId: 201,
    })
    expect(
      dataset.candles.every(
        (candle) => candle.bucketEnd <= dataset.asOfTimestamp,
      ),
    ).toBe(true)
  })

  it('rejects freezing a dataset with unresolved gaps', () => {
    const gap: BackfillGapEvidence = {
      kind: 'trade_id',
      window: {
        index: 0,
        startTime: T0 as TimestampMs,
        endTime: (T0 + 60_000) as TimestampMs,
      },
      previousTradeId: 201,
      nextTradeId: 203,
      missingTradeIds: [202],
      detectedAt: CLOCK as TimestampMs,
      resolved: false,
      resolution: 'unresolved',
    }

    expect(() =>
      freezeReplayDataset({
        interval: '1m',
        importVersion: 'kraken-time-and-sales.v1',
        trades: closedTrades,
        gaps: [gap],
        conflicts: [],
      }),
    ).toThrow(ReplayDatasetFreezeError)
  })

  it('rejects freezing a dataset with conflicting duplicates', () => {
    const conflict: BackfillConflictEvidence = {
      tradeId: 202,
      window: {
        index: 0,
        startTime: T0 as TimestampMs,
        endTime: (T0 + 60_000) as TimestampMs,
      },
      existing: closedTrades[2] as ReplayTrade,
      incoming: trade({ tradeId: 202, eventTime: T0 + 70_000, price: 202 }),
      detectedAt: CLOCK as TimestampMs,
    }

    expect(() =>
      freezeReplayDataset({
        interval: '1m',
        importVersion: 'kraken-time-and-sales.v1',
        trades: closedTrades,
        gaps: [],
        conflicts: [conflict],
      }),
    ).toThrow(ReplayDatasetFreezeError)
  })

  it('produces the same canonical dataset hash for the same fixture input', () => {
    const first = freezeReplayDataset({
      interval: '1m',
      importVersion: 'kraken-time-and-sales.v1',
      trades: closedTrades,
      gaps: [],
      conflicts: [],
    })
    const second = freezeReplayDataset({
      interval: '1m',
      importVersion: 'kraken-time-and-sales.v1',
      trades: closedTrades.map((entry) => ({
        ...entry,
        receivedTime: (CLOCK + 5_000) as TimestampMs,
      })),
      gaps: [],
      conflicts: [],
    })
    expect(second.datasetHash).toBe(first.datasetHash)

    const nextVersion = freezeReplayDataset({
      interval: '1m',
      importVersion: 'kraken-time-and-sales.v2',
      trades: closedTrades,
      gaps: [],
      conflicts: [],
    })
    expect(nextVersion.datasetHash).not.toBe(first.datasetHash)
  })
})

describe('replay dataset store', () => {
  it('persists frozen datasets durably without touching the live database', () => {
    const path = makePath()
    const dataset = freezeReplayDataset({
      interval: '1m',
      importVersion: 'kraken-time-and-sales.v1',
      trades: closedTrades,
      gaps: [],
      conflicts: [],
    })

    const store = new ReplayDatasetStore({ path })
    expect(store.saveDataset(dataset).outcome).toBe('inserted')
    expect(store.saveDataset(dataset).outcome).toBe('duplicate')
    expect(store.getDataset(dataset.datasetHash)).toEqual(dataset)
    expect(store.listDatasets()).toEqual([dataset])
    store.close()

    const reopened = new ReplayDatasetStore({ path })
    expect(reopened.getDataset(dataset.datasetHash)).toEqual(dataset)
    reopened.close()
  })

  it('supports in-memory storage for tests', () => {
    const store = new ReplayDatasetStore({ path: ':memory:' })
    const dataset = freezeReplayDataset({
      interval: '1m',
      importVersion: 'kraken-time-and-sales.v1',
      trades: closedTrades,
      gaps: [],
      conflicts: [],
    })
    store.saveDataset(dataset)
    expect(store.listDatasets()).toHaveLength(1)
    store.close()
  })
})
