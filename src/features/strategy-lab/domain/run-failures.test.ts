import { describe, expect, it } from 'vitest'
import { failureReasons } from './run-failures.ts'
import type { RunSummary } from '../infrastructure/run-visual-api.ts'

const base: RunSummary = {
  verdict: 'NO PASA',
  verdict_note: null,
  inconclusive_reasons: [],
  trades: 120,
  min_trades: 100,
  mean_bp: -10,
  ci: [-20, -1],
  positive_folds: 1,
  folds: 5,
  min_positive_fold_share: 0.6,
  percentile: 40,
  min_percentile: 95,
  funding_share: 1,
  funding_status: {},
  open_at_end: null,
  contaminated: false,
}

describe('failureReasons', () => {
  it('says nothing for a PASA', () => {
    expect(failureReasons({ ...base, verdict: 'PASA' })).toEqual([])
  })

  it('rebuilds the reasons from the figures of a run saved without its rules', () => {
    const reasons = failureReasons(base)
    expect(reasons).toHaveLength(3)
    expect(reasons[0]).toContain('Perdió en promedio')
    expect(reasons[1]).toContain('No le ganó al azar')
    expect(reasons[2]).toContain('1 de 5 periodos')
  })

  it('names why an inconclusive verdict could not decide', () => {
    expect(
      failureReasons({
        ...base,
        verdict: 'INCONCLUSO',
        inconclusive_reasons: ['few_trades', 'funding'],
      }),
    ).toEqual([
      'Hay muy pocas operaciones para decidir.',
      'Falta el funding de muchas operaciones, y sin él el resultado es optimista.',
    ])
  })

  it('uses the stored rules and lists only the failed ones', () => {
    const reasons = failureReasons({
      ...base,
      rules: [
        { id: 'n_trades', label: 'n', value: 50, threshold: 100, ok: false },
        { id: 'cost_stress', label: 'c', value: -3, threshold: 0, ok: true },
      ],
    })
    expect(reasons).toEqual([
      'Pocas operaciones: hizo 50 y se piden al menos 100.',
    ])
  })
})
