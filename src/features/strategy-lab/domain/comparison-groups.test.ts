import { describe, expect, it } from 'vitest'
import { retiredReason } from './comparison-groups.ts'

describe('retiredReason', () => {
  it('words the engine D code', () => {
    expect(retiredReason('closed_with_engine_d')).toBe(
      'se cerró con el motor viejo D: sin ventaja tras costes',
    )
  })
  it('drops the repeated date and the reactivation instruction', () => {
    expect(
      retiredReason(
        'apagada desde 2026-10-18: Decisión del propietario: usa X. Para reactivarla, borrar este bloque "off".',
      ),
    ).toBe('Decisión del propietario: usa X.')
  })
  it('drops the retirement prefix and tolerates no reason', () => {
    expect(retiredReason('Retirada (18-oct): ya no se usa')).toBe(
      'ya no se usa',
    )
    expect(retiredReason(null)).toBeNull()
  })
})
