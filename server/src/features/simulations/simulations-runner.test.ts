import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TimestampMs } from '../../domain/contracts.ts'
import { MarketStore } from '../market-data/market-store.ts'
import { SIMULATION_CANDIDATES } from './candidate-manifest.ts'
import { runSimulationsFromLiveDb } from './simulations-runner.ts'

const tempDirectories: string[] = []

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function makePaths() {
  const directory = mkdtempSync(join(tmpdir(), 'balancita-simulations-'))
  tempDirectories.push(directory)
  return {
    marketDbPath: join(directory, 'market.sqlite'),
    datasetDbPath: join(directory, 'simulations-datasets.sqlite'),
    runsDbPath: join(directory, 'simulations-runs.sqlite'),
    ledgerDbPath: join(directory, 'simulations-ledger.sqlite'),
    reportPath: join(directory, 'simulations-report.json'),
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

describe('simulations runner', () => {
  it('runs every manifest candidate and writes a full report-all table', () => {
    const paths = makePaths()
    seedContiguousMarket(paths.marketDbPath)

    const result = runSimulationsFromLiveDb({
      ...paths,
      horizons: ['15m'],
      selectionPct: 0.7,
      clock: () => 1 as TimestampMs,
    })

    expect(result.datasetHash).toMatch(/^[0-9a-f]{64}$/)
    expect(result.manifestHash).toMatch(/^[0-9a-f]{64}$/)
    expect(result.horizons).toHaveLength(1)
    const horizon = result.horizons[0]!
    expect(horizon.horizon).toBe('15m')
    expect(horizon.report.rows).toHaveLength(SIMULATION_CANDIDATES.length)
    const briers = horizon.report.rows.map((row) => row.brier)
    expect(briers).toEqual([...briers].sort((a, b) => (a ?? 2) - (b ?? 2)))
    for (const row of horizon.report.rows) {
      expect(row.runId).toContain(row.candidateId)
    }
    expect(horizon.report.winner).not.toBeNull()
    expect(horizon.report.selectionCount).toBeGreaterThan(0)
    expect(horizon.report.validationCount).toBeGreaterThan(0)

    const persisted = JSON.parse(readFileSync(paths.reportPath, 'utf8'))
    expect(persisted.reports[0].contentHash).toBe(horizon.report.contentHash)
  }, 45_000)

  it('hits the persisted report when the live dataset and request identity match', () => {
    const paths = makePaths()
    seedContiguousMarket(paths.marketDbPath)
    const options = {
      ...paths,
      horizons: ['15m'] as const,
      selectionPct: 0.7,
      clock: () => 1 as TimestampMs,
    }
    const first = runSimulationsFromLiveDb(options)
    const second = runSimulationsFromLiveDb(options)
    expect(second.horizons[0]!.report.rows.map((row) => row.runId)).toEqual(
      first.horizons[0]!.report.rows.map((row) => row.runId),
    )
    expect(second.horizons[0]!.report.contentHash).toBe(
      first.horizons[0]!.report.contentHash,
    )
    expect(JSON.parse(readFileSync(paths.reportPath, 'utf8')).generatedAt).toBe(
      1,
    )
  }, 45_000)

  it('misses the cache when a simulation parameter changes', () => {
    const paths = makePaths()
    seedContiguousMarket(paths.marketDbPath)
    runSimulationsFromLiveDb({
      ...paths,
      horizons: ['15m'],
      clock: () => 1 as TimestampMs,
    })
    const changed = runSimulationsFromLiveDb({
      ...paths,
      horizons: ['15m'],
      selectionPct: 0.6,
      clock: () => 2 as TimestampMs,
    })
    expect(changed.selectionPct).toBe(0.6)
    expect(JSON.parse(readFileSync(paths.reportPath, 'utf8')).generatedAt).toBe(
      2,
    )
  }, 45_000)

  it('invalidates the cache when the live dataset changes', () => {
    const paths = makePaths()
    seedContiguousMarket(paths.marketDbPath)
    const initial = runSimulationsFromLiveDb({
      ...paths,
      horizons: ['15m'],
      clock: () => 1 as TimestampMs,
    })
    const store = new MarketStore({ path: paths.marketDbPath })
    const eventTime = T0 + CANDLES * MINUTE_MS + 10_000
    store.insertObservation({
      source: 'kraken',
      symbol: 'BTC-EUR',
      instrumentId: 'BTC-EUR',
      eventTime: eventTime as TimestampMs,
      receivedTime: (eventTime + 100) as TimestampMs,
      displayTime: (eventTime + 100) as TimestampMs,
      sequence: 5_000 + CANDLES,
      payload: {
        type: 'trade',
        productId: 'BTC-EUR',
        tradeId: 5_000 + CANDLES,
        sequence: 5_000 + CANDLES,
        price: 60_000 + CANDLES,
        qty: 0.01,
        side: 'buy',
        orderType: 'limit',
      },
      status: 'live',
      freshness: { ageMs: 100, isStale: false, clockInverted: false },
    })
    store.close()
    const changed = runSimulationsFromLiveDb({
      ...paths,
      horizons: ['15m'],
      clock: () => 2 as TimestampMs,
    })
    expect(changed.datasetHash).not.toBe(initial.datasetHash)
    expect(JSON.parse(readFileSync(paths.reportPath, 'utf8')).generatedAt).toBe(
      2,
    )
  }, 45_000)

  it('refuses to write simulation output to the live market database path', () => {
    const paths = makePaths()
    seedContiguousMarket(paths.marketDbPath)
    for (const key of [
      'datasetDbPath',
      'runsDbPath',
      'ledgerDbPath',
    ] as const) {
      expect(() =>
        runSimulationsFromLiveDb({
          ...paths,
          [key]: paths.marketDbPath,
          horizons: ['15m'],
          clock: () => 1 as TimestampMs,
        }),
      ).toThrowError(/must not be the live market database/i)
    }
  })

  it('windows the frozen dataset with since/until', () => {
    const paths = makePaths()
    seedContiguousMarket(paths.marketDbPath)

    const full = runSimulationsFromLiveDb({
      ...paths,
      horizons: ['15m'],
      clock: () => 1 as TimestampMs,
    })
    const windowed = runSimulationsFromLiveDb({
      ...paths,
      horizons: ['15m'],
      since: (T0 + 100 * MINUTE_MS) as TimestampMs,
      until: (T0 + 150 * MINUTE_MS) as TimestampMs,
      clock: () => 1 as TimestampMs,
    })
    expect(windowed.horizons[0]!.report.selectionCount).toBeGreaterThan(0)
    expect(windowed.datasetHash).not.toBe(full.datasetHash)
    expect(
      windowed.horizons[0]!.report.selectionCount +
        windowed.horizons[0]!.report.validationCount,
    ).toBeLessThan(
      full.horizons[0]!.report.selectionCount +
        full.horizons[0]!.report.validationCount,
    )
  }, 45_000)

  it('fails honestly when the live database holds no usable observations', () => {
    const paths = makePaths()
    const store = new MarketStore({ path: paths.marketDbPath })
    store.close()
    expect(() =>
      runSimulationsFromLiveDb({
        ...paths,
        horizons: ['15m'],
        clock: () => 1 as TimestampMs,
      }),
    ).toThrow()
  })
})
