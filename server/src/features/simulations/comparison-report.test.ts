import { describe, expect, it } from 'vitest'
import type { ForecastHorizon, TimestampMs } from '../../domain/contracts.ts'
import { SIMULATION_NEUTRAL_BAND } from './candidate-manifest.ts'
import {
  buildComparisonReport,
  type SimulationScoredEntry,
} from './comparison-report.ts'

const HORIZON: ForecastHorizon = '15m'

function entry(
  candidateId: string,
  asOf: number,
  probabilities: readonly [number, number, number],
  label: 'up' | 'down' | 'flat',
  abstained = false,
): SimulationScoredEntry {
  return {
    candidateId,
    asOfTimestamp: asOf as TimestampMs,
    forecast: {
      probabilityUp: probabilities[0],
      probabilityDown: probabilities[1],
      probabilityFlat: probabilities[2],
      abstained,
      horizon: HORIZON,
    },
    outcome: { label, realizedReturn: label === 'up' ? 0.01 : -0.01 },
  }
}

function selectionEntries(): readonly SimulationScoredEntry[] {
  return [
    entry('technical-default', 1, [0.6, 0.2, 0.2], 'up'),
    entry('technical-default', 2, [0.6, 0.2, 0.2], 'up'),
    entry('strict-quorum', 1, [0.3, 0.3, 0.4], 'up'),
    entry('strict-quorum', 2, [0.3, 0.3, 0.4], 'up'),
  ]
}

describe('simulation comparison report', () => {
  it('reports every candidate row sorted by Brier ascending', () => {
    const report = buildComparisonReport({
      horizon: HORIZON,
      datasetHash: 'abc',
      manifestHash: 'def',
      selectionPct: 0.7,
      selectionCutTimestamp: 3 as TimestampMs,
      selection: selectionEntries(),
      validation: [],
      candidates: [
        {
          candidateId: 'technical-default',
          ruleVersion: 'technical-direction.v1',
          paramSetVersion: 'technical-defaults.v1',
          runId: 'run-a',
        },
        {
          candidateId: 'strict-quorum',
          ruleVersion: 'simulation-strict-quorum.v1',
          paramSetVersion: 'technical-defaults.v1',
          runId: 'run-b',
        },
      ],
    })
    expect(report.rows).toHaveLength(2)
    expect(report.rows[0]!.candidateId).toBe('technical-default')
    expect(report.rows[0]!.brier).toBeLessThan(report.rows[1]!.brier!)
    expect(report.neutralBand).toBe(SIMULATION_NEUTRAL_BAND)
    expect(report.instrumentId).toBe('BTC-EUR')
  })

  it('declares the selection winner and validates it once on the locked slice', () => {
    const report = buildComparisonReport({
      horizon: HORIZON,
      datasetHash: 'abc',
      manifestHash: 'def',
      selectionPct: 0.7,
      selectionCutTimestamp: 3 as TimestampMs,
      selection: selectionEntries(),
      validation: [entry('technical-default', 3, [0.7, 0.1, 0.2], 'up')],
      candidates: [
        {
          candidateId: 'technical-default',
          ruleVersion: 'technical-direction.v1',
          paramSetVersion: 'technical-defaults.v1',
          runId: 'run-a',
        },
        {
          candidateId: 'strict-quorum',
          ruleVersion: 'simulation-strict-quorum.v1',
          paramSetVersion: 'technical-defaults.v1',
          runId: 'run-b',
        },
      ],
    })
    expect(report.winner?.candidateId).toBe('technical-default')
    expect(report.winner?.validationBrier).not.toBeNull()
    expect(report.rows[0]!.validationBrier).not.toBeNull()
    expect(report.rows[1]!.validationBrier).toBeNull()
  })

  it('scores the baseline trio on the same selection slice', () => {
    const report = buildComparisonReport({
      horizon: HORIZON,
      datasetHash: 'abc',
      manifestHash: 'def',
      selectionPct: 0.7,
      selectionCutTimestamp: 3 as TimestampMs,
      selection: selectionEntries(),
      validation: [],
      candidates: [
        {
          candidateId: 'technical-default',
          ruleVersion: 'technical-direction.v1',
          paramSetVersion: 'technical-defaults.v1',
          runId: 'run-a',
        },
      ],
    })
    expect(report.baselines.uniform.brier).not.toBeNull()
    expect(report.baselines.noChange.brier).not.toBeNull()
    expect(report.baselines.momentum.brier).not.toBeNull()
    // Neither outcome is observable within a 15m horizon of these two forecasts.
    // Reusing the prior forecast's eventual label here would be look-ahead.
    expect(report.baselines.momentum.brier).toBe(report.baselines.uniform.brier)
  })

  it('carries a selection-bias warning and no-profitability discipline', () => {
    const report = buildComparisonReport({
      horizon: HORIZON,
      datasetHash: 'abc',
      manifestHash: 'def',
      selectionPct: 0.7,
      selectionCutTimestamp: 3 as TimestampMs,
      selection: selectionEntries(),
      validation: [],
      candidates: [
        {
          candidateId: 'technical-default',
          ruleVersion: 'technical-direction.v1',
          paramSetVersion: 'technical-defaults.v1',
          runId: 'run-a',
        },
      ],
    })
    const text = report.limitations.join(' ')
    expect(text).toMatch(/selection/i)
    expect(text).toMatch(/profitability/i)
    expect(text).toMatch(/causal/i)
  })

  it('scores every active micro candidate and baseline on the shared eligible timestamps', () => {
    const ids = [
      'micro-trend-pullback',
      'micro-bollinger-reversion',
      'micro-donchian-breakout',
      'micro-regime-adapter',
    ]
    const selection = ids.flatMap((id, index) => [
      entry(id, 10, [0.6, 0.2, 0.2], 'up'),
      entry(id, 20, [0.6, 0.2, 0.2], 'up'),
      ...(index === 0 ? [entry(id, 30, [0.6, 0.2, 0.2], 'up')] : []),
      ...(index === 1 ? [entry(id, 40, [0.6, 0.2, 0.2], 'down')] : []),
    ])
    const report = buildComparisonReport({
      horizon: HORIZON,
      datasetHash: 'abc',
      manifestHash: 'def',
      selectionPct: 0.7,
      selectionCutTimestamp: 50 as TimestampMs,
      selection,
      validation: [],
      candidates: ids.map((candidateId) => ({
        candidateId,
        ruleVersion: 'test.v1',
        paramSetVersion: 'test.v1',
        runId: 'run',
      })),
    })
    const diagnostics = report.microCandidateDiagnostics!
    expect(diagnostics.selectionEligibleCount).toBe(2)
    expect(diagnostics.selectionStatus).toBe('computable')
    expect(diagnostics.computabilityNotice).toMatch(
      /no acredita suficiencia estadística ni viabilidad de la estrategia/i,
    )
    expect(diagnostics.selectionAsOfTimestamps).toEqual([10, 20])
    expect(
      diagnostics.candidates.map(
        (candidate) => candidate.selectionMaturedCount,
      ),
    ).toEqual([2, 2, 2, 2])
    expect(diagnostics.selectionBaselines.uniform.count).toBe(2)
  })

  it('marks micro prediction comparison insufficient when candidates have no shared timestamp', () => {
    const ids = [
      'micro-trend-pullback',
      'micro-bollinger-reversion',
      'micro-donchian-breakout',
      'micro-regime-adapter',
    ]
    const report = buildComparisonReport({
      horizon: HORIZON,
      datasetHash: 'abc',
      manifestHash: 'def',
      selectionPct: 0.7,
      selectionCutTimestamp: 50 as TimestampMs,
      selection: ids.map((id, index) =>
        entry(id, index + 1, [0.6, 0.2, 0.2], 'up'),
      ),
      validation: [],
      candidates: ids.map((candidateId) => ({
        candidateId,
        ruleVersion: 'test.v1',
        paramSetVersion: 'test.v1',
        runId: 'run',
      })),
    })
    const diagnostics = report.microCandidateDiagnostics!
    expect(diagnostics.selectionEligibleCount).toBe(0)
    expect(diagnostics.selectionStatus).toBe('insufficient')
    expect(
      diagnostics.candidates.map((candidate) => candidate.selectionBrier),
    ).toEqual([null, null, null, null])
    expect(diagnostics.selectionBaselines.uniform).toEqual({
      brier: null,
      count: 0,
    })
  })

  it('includes a registered candidate with no scored rows in the eligibility denominator', () => {
    const ids = [
      'micro-trend-pullback',
      'micro-bollinger-reversion',
      'micro-donchian-breakout',
      'micro-regime-adapter',
    ]
    const report = buildComparisonReport({
      horizon: HORIZON,
      datasetHash: 'abc',
      manifestHash: 'def',
      selectionPct: 0.7,
      selectionCutTimestamp: 50 as TimestampMs,
      selection: ids
        .slice(0, 3)
        .flatMap((id) => [
          entry(id, 10, [0.6, 0.2, 0.2], 'up'),
          entry(id, 20, [0.6, 0.2, 0.2], 'up'),
        ]),
      validation: [],
      candidates: ids.map((candidateId) => ({
        candidateId,
        ruleVersion: 'test.v1',
        paramSetVersion: 'test.v1',
        runId: 'run',
      })),
    })
    const diagnostics = report.microCandidateDiagnostics!
    expect(
      diagnostics.candidates.map((candidate) => candidate.candidateId),
    ).toEqual(ids)
    expect(diagnostics.selectionEligibleCount).toBe(0)
    expect(diagnostics.selectionStatus).toBe('insufficient')
    expect(
      diagnostics.candidates.map((candidate) => candidate.selectionBrier),
    ).toEqual([null, null, null, null])
  })
})
