import { describe, expect, it } from 'vitest'
import type { ForecastHorizon, TimestampMs } from '../../domain/contracts.ts'
import type { ForecastOutcomeLabel } from '../../domain/contracts.ts'
import {
  buildComparisonReport,
  MAX_PROFITABILITY_EQUITY_POINTS,
  type SimulationProfitabilityInput,
  type SimulationScoredEntry,
} from './comparison-report.ts'
import type { TradeSimBar, TradeSimSignal } from './trade-simulation.ts'

const HORIZON: ForecastHorizon = '15m'
const MINUTE_MS = 60_000
const T0 = 1_700_000_000_000

function bar(index: number, open: number, close: number): TradeSimBar {
  return {
    time: (T0 + (index + 1) * MINUTE_MS) as TimestampMs,
    open,
    close,
  }
}

function longSignal(index: number): TradeSimSignal {
  return {
    time: (T0 + (index + 1) * MINUTE_MS) as TimestampMs,
    probabilityUp: 0.8,
    probabilityDown: 0.1,
    abstained: false,
  }
}

function flatSignal(index: number): TradeSimSignal {
  return {
    time: (T0 + (index + 1) * MINUTE_MS) as TimestampMs,
    probabilityUp: 0.2,
    probabilityDown: 0.2,
    abstained: false,
  }
}

function entry(candidateId: string, asOf: number): SimulationScoredEntry {
  return {
    candidateId,
    asOfTimestamp: asOf as TimestampMs,
    forecast: {
      probabilityUp: 0.6,
      probabilityDown: 0.2,
      probabilityFlat: 0.2,
      abstained: false,
      horizon: HORIZON,
    },
    outcome: { label: 'up', realizedReturn: 0.01 },
  }
}

/** Rising 1..6 then flat: 8 bars so selection/validation can split. */
function bars(): TradeSimBar[] {
  return [
    bar(0, 100, 101),
    bar(1, 101, 102),
    bar(2, 102, 103),
    bar(3, 103, 104),
    bar(4, 104, 104),
    bar(5, 104, 104),
    bar(6, 104, 104),
    bar(7, 104, 104),
  ]
}

function input(): SimulationProfitabilityInput {
  const allBars = bars()
  return {
    selectionBars: allBars.slice(0, 4),
    validationBars: allBars.slice(4),
    signalsByCandidate: {
      'technical-default': [
        longSignal(0),
        longSignal(1),
        flatSignal(2),
        flatSignal(3),
        longSignal(4),
        flatSignal(5),
        flatSignal(6),
        flatSignal(7),
      ],
    },
    outcomeLabelsByTime: Object.fromEntries(
      allBars.map((candle) => [candle.time, 'up' as ForecastOutcomeLabel]),
    ),
    startingCash: 10_000,
    entryThreshold: 0.55,
    exitUpThreshold: 0.45,
    exitDownThreshold: 0.55,
    costs: { commissionRate: 0.001, slippageRate: 0.0005 },
  }
}

function baseArgs() {
  return {
    horizon: HORIZON,
    datasetHash: 'abc',
    manifestHash: 'def',
    selectionPct: 0.7,
    selectionCutTimestamp: 3 as TimestampMs,
    selection: [entry('technical-default', 1), entry('technical-default', 2)],
    validation: [entry('technical-default', 3)],
    candidates: [
      {
        candidateId: 'technical-default',
        ruleVersion: 'technical-direction.v1',
        paramSetVersion: 'technical-defaults.v1',
        runId: 'run-a',
      },
    ],
  }
}

describe('simulation comparison profitability block', () => {
  it('stays null when no profitability input is provided', () => {
    const report = buildComparisonReport(baseArgs())
    expect(report.profitability).toBeNull()
    expect(report.limitations.join(' ')).toMatch(/profitability/i)
  })

  it('records rule/costs versions, thresholds, and cash identically for all candidates', () => {
    const report = buildComparisonReport({
      ...baseArgs(),
      profitability: input(),
    })
    const block = report.profitability
    expect(block).not.toBeNull()
    expect(block!.ruleVersion).toBe('strategy-rule.v2')
    expect(block!.costsVersion).toBe('costs.v1')
    expect(block!.costs).toEqual({
      commissionRate: 0.001,
      slippageRate: 0.0005,
    })
    expect(block!.startingCash).toBe(10_000)
    expect(block!.entryThreshold).toBe(0.55)
    expect(block!.exitUpThreshold).toBe(0.45)
    expect(block!.exitDownThreshold).toBe(0.55)
  })

  it('simulates every candidate on both slices with downsampled equity curves', () => {
    const report = buildComparisonReport({
      ...baseArgs(),
      profitability: input(),
    })
    const block = report.profitability!
    expect(block.candidates).toHaveLength(1)
    const candidate = block.candidates[0]!
    expect(candidate.candidateId).toBe('technical-default')
    // Selection: long at 0 → buy fills at bar 1 open; flat at 2 → sell at bar 3 open.
    expect(candidate.selection.metrics.tradeCount).toBe(1)
    expect(candidate.selection.equityCurve.length).toBeLessThanOrEqual(
      MAX_PROFITABILITY_EQUITY_POINTS,
    )
    expect(candidate.validation.metrics.tradeCount).toBeGreaterThanOrEqual(0)
    expect(candidate.selection.ledgerHash).toMatch(/^[0-9a-f]{64}$/)
    // Equity curve covers the slice window end to end.
    expect(candidate.selection.equityCurve[0]!.time).toBe(
      input().selectionBars[0]!.time,
    )
    expect(candidate.selection.equityCurve.at(-1)!.time).toBe(
      input().selectionBars.at(-1)!.time,
    )
  })

  it('simulates the baseline trio with the same engine and costs', () => {
    const report = buildComparisonReport({
      ...baseArgs(),
      profitability: input(),
    })
    const baselines = report.profitability!.baselines
    expect(baselines.uniform.selection.metrics.tradeCount).toBe(0)
    expect(baselines.uniform.validation.metrics.tradeCount).toBe(0)
    expect(baselines.noChange.selection.metrics.tradeCount).toBe(1)
    expect(baselines.noChange.validation.metrics.tradeCount).toBe(1)
    expect(
      baselines.momentum.selection.metrics.tradeCount,
    ).toBeGreaterThanOrEqual(0)
  })

  it('exposes buy-and-hold equity for the visual comparison', () => {
    const report = buildComparisonReport({
      ...baseArgs(),
      profitability: input(),
    })
    const block = report.profitability!
    expect(block.buyAndHoldEquity.selection.length).toBeGreaterThan(0)
    expect(block.buyAndHoldEquity.selection).toEqual(
      block.baselines.noChange.selection.equityCurve,
    )
    expect(block.buyAndHoldEquity.validation).toEqual(
      block.baselines.noChange.validation.equityCurve,
    )
  })

  it('extends limitations for simulation when the block is present', () => {
    const report = buildComparisonReport({
      ...baseArgs(),
      profitability: input(),
    })
    const text = report.limitations.join(' ')
    expect(text).toMatch(/simulated/i)
    expect(text).toMatch(/estimated costs/i)
    expect(text).toMatch(/not predictive/i)
    expect(text).toMatch(/regime/i)
  })

  it('stays deterministic: same input yields the same content hash', () => {
    const first = buildComparisonReport({
      ...baseArgs(),
      profitability: input(),
    })
    const second = buildComparisonReport({
      ...baseArgs(),
      profitability: input(),
    })
    expect(second.contentHash).toBe(first.contentHash)
  })

  it('handles empty windows without fabricating trades', () => {
    const empty: SimulationProfitabilityInput = {
      ...input(),
      selectionBars: [],
      validationBars: [],
      signalsByCandidate: {},
      outcomeLabelsByTime: {},
    }
    const report = buildComparisonReport({
      ...baseArgs(),
      profitability: empty,
    })
    const candidate = report.profitability!.candidates[0]!
    expect(candidate.selection.metrics.tradeCount).toBe(0)
    expect(candidate.selection.metrics.winRate).toBeNull()
    expect(candidate.selection.metrics.finalEquity).toBe(10_000)
    expect(candidate.selection.equityCurve).toHaveLength(0)
  })
})
