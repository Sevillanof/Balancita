import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TimestampMs } from '../../domain/contracts.ts'
import { MarketStore } from '../market-data/market-store.ts'
import { KRAKEN_OBSERVATIONS_IMPORT_VERSION } from './kraken-observation-import.ts'
import { ReplayDatasetStore } from './replay-dataset-store.ts'
import { runReplayFromLiveDb } from './replay-runner.ts'

const tempDirectories: string[] = []

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

interface RunnerPaths {
  readonly marketDbPath: string
  readonly datasetDbPath: string
  readonly runsDbPath: string
  readonly ledgerDbPath: string
}

function makePaths(): RunnerPaths {
  const directory = mkdtempSync(join(tmpdir(), 'balancita-replay-runner-'))
  tempDirectories.push(directory)
  return {
    marketDbPath: join(directory, 'market.sqlite'),
    datasetDbPath: join(directory, 'replay-datasets.sqlite'),
    runsDbPath: join(directory, 'replay-runs.sqlite'),
    ledgerDbPath: join(directory, 'replay-ledger.sqlite'),
  }
}

const T0 = 1_789_984_800_000
const MINUTE_MS = 60_000
const CANDLES = 200

function seedContiguousMarket(path: string): void {
  const store = new MarketStore({ path })
  for (let index = 0; index < CANDLES; index += 1) {
    const eventTime = T0 + index * MINUTE_MS + 10_000
    store.insertObservation({
      source: 'kraken',
      symbol: 'BTC-EUR',
      instrumentId: 'BTC-EUR',
      eventTime: eventTime as TimestampMs,
      receivedTime: (eventTime + 100) as TimestampMs,
      displayTime: (eventTime + 100) as TimestampMs,
      sequence: 5_000 + index,
      payload: {
        type: 'trade',
        productId: 'BTC-EUR',
        tradeId: 5_000 + index,
        sequence: 5_000 + index,
        price: 60_000 + index,
        qty: 0.01,
        side: index % 2 === 0 ? 'buy' : 'sell',
        orderType: 'limit',
      },
      status: 'live',
      freshness: { ageMs: 100, isStale: false, clockInverted: false },
    })
  }
  store.close()
}

function ledgerCounts(ledgerDbPath: string): {
  forecasts: number
  outcomes: number
} {
  const ledger = new MarketStore({ path: ledgerDbPath })
  const counts = {
    forecasts: ledger.forecastCount(),
    outcomes: ledger.listOutcomes().length,
  }
  ledger.close()
  return counts
}

describe('replay runner', () => {
  it('runs one deterministic run per horizon', () => {
    const paths = makePaths()
    seedContiguousMarket(paths.marketDbPath)

    const result = runReplayFromLiveDb({
      ...paths,
      horizons: ['15m', '1h', '4h', '24h'],
      clock: () => 1 as TimestampMs,
    })

    expect(result.importVersion).toBe(KRAKEN_OBSERVATIONS_IMPORT_VERSION)
    expect(result.horizons).toHaveLength(4)
    expect(result.horizons.map((entry) => entry.horizon)).toEqual([
      '15m',
      '1h',
      '4h',
      '24h',
    ])
    const hash16 = result.datasetHash.slice(0, 16)
    for (const entry of result.horizons) {
      expect(entry.runId).toBe(
        `replay:${KRAKEN_OBSERVATIONS_IMPORT_VERSION}:${hash16}:${entry.horizon}`,
      )
      expect(entry.datasetOutcome).toBe('inserted')
    }
    const datasetStore = new ReplayDatasetStore({ path: paths.datasetDbPath })
    expect(datasetStore.listDatasets()).toHaveLength(1)
    datasetStore.close()
  }, 20_000)

  it('is idempotent: a second identical run adds no rows', () => {
    const paths = makePaths()
    seedContiguousMarket(paths.marketDbPath)
    const options = {
      ...paths,
      horizons: ['15m', '1h'] as const,
      clock: () => 1 as TimestampMs,
    }

    const first = runReplayFromLiveDb({ ...options, horizons: ['15m', '1h'] })
    const countsAfterFirst = ledgerCounts(paths.ledgerDbPath)
    expect(countsAfterFirst.forecasts).toBeGreaterThan(0)

    const second = runReplayFromLiveDb({ ...options, horizons: ['15m', '1h'] })
    const countsAfterSecond = ledgerCounts(paths.ledgerDbPath)

    expect(second.horizons.map((entry) => entry.runId)).toEqual(
      first.horizons.map((entry) => entry.runId),
    )
    expect(
      second.horizons.every((entry) => entry.datasetOutcome === 'duplicate'),
    ).toBe(true)
    expect(countsAfterSecond).toEqual(countsAfterFirst)
  })

  it('refuses to write replay output to the live market database path', () => {
    const paths = makePaths()
    seedContiguousMarket(paths.marketDbPath)

    expect(() =>
      runReplayFromLiveDb({
        ...paths,
        datasetDbPath: paths.marketDbPath,
        horizons: ['15m'],
      }),
    ).toThrow(/live market database/i)
    expect(() =>
      runReplayFromLiveDb({
        ...paths,
        runsDbPath: paths.marketDbPath,
        horizons: ['15m'],
      }),
    ).toThrow(/live market database/i)
    expect(() =>
      runReplayFromLiveDb({
        ...paths,
        ledgerDbPath: paths.marketDbPath,
        horizons: ['15m'],
      }),
    ).toThrow(/live market database/i)
  })
})
