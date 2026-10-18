import { describe, expect, it } from 'vitest'
import {
  operationalLabel,
  operationalTitle,
  researchLabel,
} from './strategy-labels.ts'

describe('strategy labels', () => {
  it('falls back to the unverified and unmeasured words for unknown values', () => {
    expect(operationalLabel('whatever')).toBe('Estado no verificado')
    expect(researchLabel('whatever')).toBe('Sin evaluación comparable')
  })
})

describe('operationalTitle', () => {
  it('shows the off reason and date, not the config hint', () => {
    const t = operationalTitle(
      'off',
      'config',
      Date.UTC(2026, 9, 18, 12),
      'decision del propietario',
    )
    expect(t).toBe(
      'Apagada desde 2026-10-18 · motivo: decision del propietario',
    )
    expect(t).not.toContain('no prueba')
  })
  it('keeps the basis hint for other states', () => {
    expect(operationalTitle('unverified', 'config')).toContain('no prueba')
  })
  it('degrades without date or reason', () => {
    expect(operationalTitle('off', 'config', null, null)).toBe('Apagada')
  })
})
