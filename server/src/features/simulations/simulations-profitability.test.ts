import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TimestampMs } from '../../domain/contracts.ts'
import { MarketStore } from '../market-data/market-store.ts'
import { getActiveCandidates } from './candidate-manifest.ts'
import { buildProfitabilityBlock } from './comparison-report.ts'
import { runSimulationsCli } from './simulations-cli.ts'
import { runSimulationsFromLiveDb } from './simulations-runner.ts'
import {
  DEFAULT_ENTRY_THRESHOLD,
  DEFAULT_EXIT_DOWN_THRESHOLD,
  DEFAULT_EXIT_UP_THRESHOLD,
  simulateBuyAndHold,
  STRATEGY_RULE_VERSION,
  type TradeSimBar,
} from './trade-simulation.ts'

const tempDirectories: string[] = []

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function makePaths() {
  const directory = mkdtempSync(join(tmpdir(), 'balancita-sim-profit-'))
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

it('applies Tier 1 commission per actual €30 buy and sell notional', () => {
  const bars: TradeSimBar[] = [
    { time: T0 as TimestampMs, open: 30, close: 30 },
    { time: (T0 + MINUTE_MS) as TimestampMs, open: 30, close: 30 },
  ]
  const result = simulateBuyAndHold({
    bars,
    startingCash: 30,
    costs: { commissionRate: 0.008, slippageRate: 0.0005 },
  })

  for (const fill of result.fills) {
    expect(fill.commission).toBeCloseTo(fill.qty * fill.price * 0.008, 10)
    expect(fill.commission).toBeCloseTo(0.24, 2)
  }
  expect(result.fills.every(({ commission }) => commission > 0)).toBe(true)
})

it('compares an explicit no-trade cash baseline on identical slices without fills or fees', () => {
  const selectionBars: TradeSimBar[] = [
    { time: T0 as TimestampMs, open: 30, close: 31 },
    { time: (T0 + MINUTE_MS) as TimestampMs, open: 31, close: 32 },
  ]
  const validationBars: TradeSimBar[] = [
    { time: (T0 + 2 * MINUTE_MS) as TimestampMs, open: 32, close: 33 },
    { time: (T0 + 3 * MINUTE_MS) as TimestampMs, open: 33, close: 34 },
  ]
  const report = buildProfitabilityBlock(
    {
      selectionBars,
      validationBars,
      signalsByCandidate: {},
      outcomeLabelsByTime: {},
      startingCash: 30,
      entryThreshold: DEFAULT_ENTRY_THRESHOLD,
      exitUpThreshold: DEFAULT_EXIT_UP_THRESHOLD,
      exitDownThreshold: DEFAULT_EXIT_DOWN_THRESHOLD,
      costs: { commissionRate: 0.008, slippageRate: 0.0005 },
    },
    ['test-candidate'],
  )
  const flat = report.baselines.flatCash
  expect(flat.selection.equityCurve.map(({ time }) => time)).toEqual(
    selectionBars.map(({ time }) => time),
  )
  expect(flat.validation.equityCurve.map(({ time }) => time)).toEqual(
    validationBars.map(({ time }) => time),
  )
  expect(flat.selection.metrics).toMatchObject({
    finalEquity: 30,
    netReturnPct: 0,
    fillCount: 0,
    tradeCount: 0,
    exposurePct: 0,
  })
  expect(flat.selection.equityCurve.every(({ equity }) => equity === 30)).toBe(
    true,
  )
  expect(flat.selection.readiness?.status).toBe('insufficient')
  expect(flat.selection.readiness?.reasons.join(' ')).toMatch(/300 operaciones/)
  expect(flat.validation.metrics.fillCount).toBe(0)
  expect(report.baselines.noChange.candidateId).toBe('noChange')
  expect(report.baselines.noChange.selection.metrics.fillCount).toBe(2)
  expect(flat.selection.ledgerHash).not.toBe(
    report.baselines.noChange.selection.ledgerHash,
  )
})

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

describe('simulations runner profitability wiring', () => {
  it('simulates every candidate on both slices with sourced Kraken fee provenance', () => {
    const paths = makePaths()
    seedContiguousMarket(paths.marketDbPath)

    const result = runSimulationsFromLiveDb({
      ...paths,
      horizons: ['15m'],
      clock: () => 1 as TimestampMs,
    })

    const block = result.horizons[0]!.report.profitability
    expect(block).not.toBeNull()
    expect(block!.ruleVersion).toBe(STRATEGY_RULE_VERSION)
    expect(block!.costs).toEqual({
      commissionRate: 0.008,
      slippageRate: 0.0005,
    })
    expect(block!.feeScenario).toEqual({
      version: 'kraken-pro-spot-btc-eur-tier1-taker.v1',
      venue: 'Kraken Pro Spot',
      pair: 'BTC-EUR',
      tier: 'Tier 1 (0+ USD qualifying 30-day volume)',
      role: 'taker',
      sourceUrl: 'https://www.kraken.com/features/fee-schedule',
      verifiedAt: '2026-09-26',
      commissionRate: 0.008,
      slippageRate: 0.0005,
      accountTier: 'unknown',
      classification: 'model-scenario-not-account-fee',
    })
    const cached = JSON.parse(readFileSync(paths.reportPath, 'utf8'))
    expect(cached.request).toMatchObject({
      feeScenarioVersion: 'kraken-pro-spot-btc-eur-tier1-taker.v1',
      commissionRate: 0.008,
      slippageRate: 0.0005,
    })
    expect(block!.startingCash).toBe(10_000)
    expect(block!.entryThreshold).toBe(0.55)
    expect(block!.exitUpThreshold).toBe(0.45)
    expect(block!.exitDownThreshold).toBe(0.55)
    expect(block!.candidates).toHaveLength(getActiveCandidates().length)
    const flat = block!.baselines.flatCash
    expect(flat.selection.metrics).toMatchObject({
      fillCount: 0,
      tradeCount: 0,
      netReturnPct: 0,
      exposurePct: 0,
    })
    expect(flat.validation.metrics.fillCount).toBe(0)
    expect(flat.selection.readiness?.status).toBe('insufficient')
    expect(flat.validation.readiness?.status).toBe('insufficient')
    expect(flat.selection.equityCurve.map(({ time }) => time)).toEqual(
      block!.candidates[0]!.selection.equityCurve.map(({ time }) => time),
    )
    expect(flat.validation.equityCurve.map(({ time }) => time)).toEqual(
      block!.candidates[0]!.validation.equityCurve.map(({ time }) => time),
    )
    expect(block!.baselines.noChange.selection.metrics.fillCount).toBe(2)
    for (const entry of block!.candidates) {
      expect(entry.selection.ledgerHash).toMatch(/^[0-9a-f]{64}$/)
      expect(entry.validation.ledgerHash).toMatch(/^[0-9a-f]{64}$/)
      expect(entry.selection.equityCurve.length).toBeGreaterThan(0)
    }
    expect(block!.buyAndHoldEquity.selection.length).toBeGreaterThan(0)
    expect(block!.buyAndHoldEquity.validation.length).toBeGreaterThan(0)
    const text = result.horizons[0]!.report.limitations.join(' ')
    expect(text).toMatch(/simulated/i)
  }, 20_000)

  it('records custom cash and thresholds identically for all candidates', () => {
    const paths = makePaths()
    seedContiguousMarket(paths.marketDbPath)

    const result = runSimulationsFromLiveDb({
      ...paths,
      horizons: ['15m'],
      startingCash: 5_000,
      entryThreshold: 0.6,
      exitThreshold: 0.4,
      clock: () => 1 as TimestampMs,
    })

    const block = result.horizons[0]!.report.profitability!
    expect(block.startingCash).toBe(5_000)
    expect(block.entryThreshold).toBe(0.6)
    expect(block.exitUpThreshold).toBe(0.4)
  }, 20_000)

  it('rejects invalid cash and threshold options before running', () => {
    const paths = makePaths()
    seedContiguousMarket(paths.marketDbPath)
    const base = {
      ...paths,
      horizons: ['15m'] as const,
      clock: () => 1 as TimestampMs,
    }
    expect(() =>
      runSimulationsFromLiveDb({ ...base, startingCash: 0 }),
    ).toThrowError(/starting cash/i)
    expect(() =>
      runSimulationsFromLiveDb({ ...base, entryThreshold: 1.5 }),
    ).toThrowError(/threshold/i)
    expect(() =>
      runSimulationsFromLiveDb({
        ...base,
        entryThreshold: 0.4,
        exitThreshold: 0.5,
      }),
    ).toThrowError(/threshold/i)
  })

  it('parses --cash/--entry/--exit flags with documented defaults', () => {
    const paths = makePaths()
    seedContiguousMarket(paths.marketDbPath)

    const output = runSimulationsCli(
      [
        '--market-db',
        paths.marketDbPath,
        '--dataset-db',
        paths.datasetDbPath,
        '--runs-db',
        paths.runsDbPath,
        '--ledger-db',
        paths.ledgerDbPath,
        '--report',
        paths.reportPath,
        '--horizon',
        '15m',
        '--cash',
        '5000',
        '--entry',
        '0.6',
        '--exit',
        '0.4',
      ],
      tmpdir(),
    )
    const result = JSON.parse(output)
    const block = result.horizons[0].report.profitability
    expect(block.startingCash).toBe(5_000)
    expect(block.entryThreshold).toBe(0.6)
    expect(block.exitUpThreshold).toBe(0.4)
  }, 20_000)

  it('rejects invalid --cash/--entry/--exit flag values', () => {
    const paths = makePaths()
    seedContiguousMarket(paths.marketDbPath)
    const base = [
      '--market-db',
      paths.marketDbPath,
      '--dataset-db',
      paths.datasetDbPath,
      '--runs-db',
      paths.runsDbPath,
      '--ledger-db',
      paths.ledgerDbPath,
      '--report',
      paths.reportPath,
      '--horizon',
      '15m',
    ]
    expect(() =>
      runSimulationsCli([...base, '--cash', '0'], tmpdir()),
    ).toThrowError(/--cash/i)
    expect(() =>
      runSimulationsCli([...base, '--entry', '2'], tmpdir()),
    ).toThrowError(/--entry/i)
    expect(() =>
      runSimulationsCli([...base, '--exit', '-0.1'], tmpdir()),
    ).toThrowError(/--exit/i)
  })
})
