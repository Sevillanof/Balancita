import { describe, expect, it } from 'vitest'
import { formatMicroCandidateTable, runSimulationsCli } from './simulations-cli.ts'

describe('simulation sample CLI validation', () => {
  it('prints the four micro candidates and three baselines with test counts and trade counts', () => {
    const text = formatMicroCandidateTable({
      candleCount: 225,
      horizons: [
        diagnosticHorizon('15m', 160),
        diagnosticHorizon('1h', 104),
      ] as never,
    } as never)
    expect(text.startsWith('[PRELIMINAR - BUFFER 225m - N_15m=160 / N_1h=104]\n')).toBe(true)
    expect(text).toContain('micro-regime-adapter')
    expect(text).toContain('uniform')
    expect(text).toContain('104')
  })

  it('keeps CLI table output empty when a report has no micro diagnostics', () => {
    expect(
      formatMicroCandidateTable({
        candleCount: 225,
        horizons: [
          { horizon: '15m', report: { microCandidateDiagnostics: null } },
        ] as never,
      } as never),
    ).toBe('')
  })

  it('rejects an unknown explicit stage before touching any database', () => {
    expect(() => runSimulationsCli(['--stage', 'invalid'], '/tmp')).toThrow(
      /stage/i,
    )
  })

  it('requires a visible deterministic seed for sample stages', () => {
    expect(() => runSimulationsCli(['--stage', 'smoke'], '/tmp')).toThrow(
      /seed/i,
    )
  })

  it('rejects a malformed sample seed before touching any database', () => {
    expect(() =>
      runSimulationsCli(['--stage', 'smoke', '--seed', '-1'], '/tmp'),
    ).toThrow(/seed/i)
  })
})

function diagnosticHorizon(horizon: string, maturedCount: number) {
  return {
    horizon,
    report: {
      microCandidateDiagnostics: {
        candidates: ['micro-trend-pullback', 'micro-bollinger-reversion', 'micro-donchian-breakout', 'micro-regime-adapter'].map((candidateId) => ({ candidateId, validationMaturedCount: maturedCount, validationBrier: 0.4, validationFillCount: 2, validationRoundTripCount: 1 })),
        validationBaselines: Object.fromEntries(['uniform', 'noChange', 'momentum'].map((key) => [key, { count: maturedCount, brier: 2 / 3 }])),
      },
      profitability: { baselines: Object.fromEntries(['uniform', 'noChange', 'momentum'].map((key) => [key, { validation: { metrics: { fillCount: 0, tradeCount: 0 } } }])) },
    },
  }
}
