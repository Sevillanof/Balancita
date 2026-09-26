import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TimestampMs } from '../../domain/contracts.ts'
import { MarketStore } from '../market-data/market-store.ts'
import {
  listSimulationReportHistory,
  simulationReportId,
} from './simulations-history.ts'
import { getActiveCandidates } from './candidate-manifest.ts'
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

function seedContiguousMarket(
  path: string,
  count = CANDLES,
  priceAt: (index: number) => number = (index) => 60_000 + index,
): void {
  const store = new MarketStore({ path })
  for (let index = 0; index < count; index += 1) {
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
        price: priceAt(index),
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
  it('runs active candidates only while retaining the full manifest identity', () => {
    const paths = makePaths()
    seedContiguousMarket(paths.marketDbPath)

    const result = runSimulationsFromLiveDb({
      ...paths,
      horizons: ['15m'],
      selectionPct: 0.7,
      clock: () => 1 as TimestampMs,
    })

    expect(result.datasetHash).toMatch(/^[0-9a-f]{64}$/)
    expect(result.marketDataCoverage.measuredAt).toBe(1)
    expect(result.marketDataCoverage.observations).toMatchObject({
      source: 'kraken_market_observations',
      count: CANDLES,
      firstReceivedTime: T0 + 10_100,
    })
    expect(result.marketDataCoverage.ohlc).toMatchObject({
      source: 'kraken_rest_ohlc_1m',
      count: 0,
      status: 'missing',
    })
    expect(result.manifestHash).toMatch(/^[0-9a-f]{64}$/)
    expect(result.horizons).toHaveLength(1)
    const horizon = result.horizons[0]!
    expect(horizon.horizon).toBe('15m')
    expect(horizon.report.rows).toHaveLength(0)
    expect(
      horizon.report.rows.map(({ candidateId }) => candidateId),
    ).not.toContain('technical-default')
    expect(
      horizon.report.microCandidateDiagnostics?.candidates.map(
        ({ candidateId }) => candidateId,
      ),
    ).toEqual(getActiveCandidates().map(({ candidateId }) => candidateId))
    expect(horizon.report.microCandidateDiagnostics?.candidates).toHaveLength(4)
    expect(horizon.report.microCandidateDiagnostics?.holdoutConsumed).toBe(true)
    const briers = horizon.report.rows.map((row) => row.brier)
    expect(briers).toEqual([...briers].sort((a, b) => (a ?? 2) - (b ?? 2)))
    for (const row of horizon.report.rows) {
      expect(row.runId).toContain(row.candidateId)
    }
    expect(horizon.report.winner).toBeNull()
    expect(horizon.report.selectionCount).toBe(0)
    expect(horizon.report.validationCount).toBe(0)

    const persisted = JSON.parse(readFileSync(paths.reportPath, 'utf8'))
    expect(persisted.reports[0].contentHash).toBe(horizon.report.contentHash)
    expect(persisted.marketDataCoverage.observations.source).toBe(
      'kraken_market_observations',
    )
    expect(persisted.marketDataCoverage.ohlc.source).toBe('kraken_rest_ohlc_1m')
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

  it('keeps a legacy cache hit without rewriting or upgrading its coverage snapshot', () => {
    const paths = makePaths()
    seedContiguousMarket(paths.marketDbPath)
    const options = {
      ...paths,
      horizons: ['15m'] as const,
      clock: () => 1 as TimestampMs,
    }
    runSimulationsFromLiveDb(options)
    const legacy = JSON.parse(readFileSync(paths.reportPath, 'utf8'))
    delete legacy.marketDataCoverage
    writeFileSync(paths.reportPath, JSON.stringify(legacy))

    const cached = runSimulationsFromLiveDb({
      ...options,
      clock: () => (T0 + CANDLES * MINUTE_MS) as TimestampMs,
    })
    const persisted = JSON.parse(readFileSync(paths.reportPath, 'utf8'))

    expect(cached.marketDataCoverage.measuredAt).toBe(T0 + CANDLES * MINUTE_MS)
    expect(persisted.marketDataCoverage).toBeUndefined()
    expect(persisted.generatedAt).toBe(1)
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

  it('keeps every newly generated report in distinct history while cache hits add nothing', () => {
    const paths = makePaths()
    seedContiguousMarket(paths.marketDbPath)
    runSimulationsFromLiveDb({
      ...paths,
      horizons: ['15m'],
      clock: () => 1 as TimestampMs,
    })
    const firstReport = JSON.parse(readFileSync(paths.reportPath, 'utf8'))
    runSimulationsFromLiveDb({
      ...paths,
      horizons: ['15m'],
      clock: () => 1 as TimestampMs,
    })
    runSimulationsFromLiveDb({
      ...paths,
      horizons: ['15m'],
      selectionPct: 0.6,
      stage: 'smoke',
      seed: 19,
      clock: () => 2 as TimestampMs,
    })
    const history = listSimulationReportHistory(paths.reportPath)
    expect(history).toHaveLength(2)
    expect(history[0]!.id).not.toBe(history[1]!.id)
    expect(history.map((entry) => entry.generatedAt)).toEqual([2, 1])
    expect(JSON.parse(readFileSync(paths.reportPath, 'utf8')).generatedAt).toBe(
      2,
    )
    expect(
      history.find((entry) => entry.id === simulationReportId(firstReport))
        ?.generatedAt,
    ).toBe(1)
  }, 45_000)

  it('runs every active candidate in smoke and confirmation selection/holdout diagnostics and profitability', () => {
    const paths = makePaths()
    const minuteCount = 8 * 24 * 60
    seedContiguousMarket(
      paths.marketDbPath,
      minuteCount,
      (index) =>
        60_000 +
        (index % 180 < 90 ? index % 90 : 90 - (index % 90)) * 8 +
        Math.sin(index / 11) * 20,
    )
    const activeIds = getActiveCandidates().map(
      ({ candidateId }) => candidateId,
    )
    const smoke = runSimulationsFromLiveDb({
      ...paths,
      horizons: ['15m'],
      stage: 'smoke',
      seed: 13,
      clock: () => 1 as TimestampMs,
    })
    const smokeReport = smoke.horizons[0]!.report
    const persistedSmoke = JSON.parse(readFileSync(paths.reportPath, 'utf8'))
    expect(persistedSmoke.sample.candidateIds).toEqual(activeIds)
    expect(smokeReport.microCandidateDiagnostics?.candidates).toHaveLength(4)
    expect(
      smokeReport.profitability?.candidates.map((entry) => entry.candidateId),
    ).toEqual(activeIds)

    const confirm = runSimulationsFromLiveDb({
      ...paths,
      horizons: ['15m', '1h'],
      stage: 'confirm',
      seed: 29,
      clock: () => 2 as TimestampMs,
    })
    const confirmReport = confirm.horizons[0]!.report
    const persistedConfirm = JSON.parse(readFileSync(paths.reportPath, 'utf8'))
    expect(persistedConfirm.sample.candidateIds).toEqual(activeIds)
    expect(persistedConfirm.sample.since).toBeGreaterThanOrEqual(
      persistedSmoke.sample.until + 60 * MINUTE_MS,
    )
    expect(
      confirmReport.microCandidateDiagnostics?.candidates.map(
        ({ candidateId }) => candidateId,
      ),
    ).toEqual(activeIds)
    expect(
      confirmReport.microCandidateDiagnostics?.candidates.every(
        (entry) =>
          entry.selectionMaturedCount > 0 && entry.validationMaturedCount > 0,
      ),
    ).toBe(true)
    expect(
      confirmReport.profitability?.candidates.map((entry) => entry.candidateId),
    ).toEqual(activeIds)
    expect(confirmReport.profitability?.costs).toMatchObject({
      commissionRate: 0.008,
      slippageRate: 0.0005,
    })
    for (const { report } of confirm.horizons) {
      expect(
        report.microCandidateDiagnostics?.candidates.map(
          ({ candidateId }) => candidateId,
        ),
      ).toEqual(activeIds)
      expect(
        report.profitability?.candidates.map((entry) => entry.candidateId),
      ).toEqual(activeIds)
    }
    expect(
      confirmReport.profitability?.candidates.every(
        (entry) =>
          entry.selection.equityCurve.length > 0 &&
          entry.validation.equityCurve.length > 0,
      ),
    ).toBe(true)
    const profitability = confirmReport.profitability!
    expect(
      profitability.candidates.some(
        (entry) => entry.validation.metrics.netReturnPct < 0,
      ),
    ).toBe(true)
    expect(
      profitability.candidates.every(
        (entry) =>
          entry.selection.readiness?.status === 'insufficient' &&
          entry.validation.readiness?.status === 'insufficient',
      ),
    ).toBe(true)
    const timestampsFor = (points: readonly { readonly time: number }[]) =>
      points.map(({ time }) => time)
    for (const entry of profitability.candidates) {
      expect(timestampsFor(entry.selection.equityCurve)).toEqual(
        timestampsFor(profitability.baselines.flatCash.selection.equityCurve),
      )
      expect(timestampsFor(entry.validation.equityCurve)).toEqual(
        timestampsFor(profitability.baselines.flatCash.validation.equityCurve),
      )
    }
    expect(listSimulationReportHistory(paths.reportPath)).toHaveLength(2)
  }, 180_000)

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
    expect(windowed.datasetHash).not.toBe(full.datasetHash)
    expect(windowed.marketDataCoverage.observations).toEqual(
      full.marketDataCoverage.observations,
    )
    expect(windowed.marketDataCoverage.observations).toMatchObject({
      count: CANDLES,
      firstEventTime: T0 + 10_000,
      lastEventTime: T0 + (CANDLES - 1) * MINUTE_MS + 10_000,
    })
    expect(
      windowed.horizons[0]!.report.microCandidateDiagnostics!.candidates[0]!
        .forecastOrigins,
    ).toBeLessThan(
      full.horizons[0]!.report.microCandidateDiagnostics!.candidates[0]!
        .forecastOrigins,
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
