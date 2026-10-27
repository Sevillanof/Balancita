import { describe, expect, it } from 'vitest'
import { decisionView, masterGlyph } from './terminal-decision-view.ts'

const base = {
  formula: {
    maestro: 2,
    portero_si: true,
    motivo: 'maestro fuerte y portero a favor',
  },
}

describe('decisionView', () => {
  it('reads an entry the formula took and Qwen agreed with', () => {
    const view = decisionView({
      ...base,
      action: 'LONG',
      formula_action: 'LARGO',
      model_action: 'LARGO',
      p_action: 0.62,
      opinion_agrees: 1,
    })
    expect(view.kind).toBe('enter-long')
    expect(view.gate).toBe(true)
    expect(view.opinion).toMatchObject({
      state: 'agrees',
      label: 'largo',
      p: '62 %',
    })
    expect(view.relevant).toBe(true)
  })

  it('tells a stopped entry from a quiet wait', () => {
    const blocked = decisionView({
      formula: {
        maestro: 2,
        portero_si: false,
        motivo: 'el portero dice que no conviene',
      },
      formula_action: 'ESPERAR',
    })
    expect(blocked.kind).toBe('blocked')
    expect(blocked.gate).toBe(false)
    const quiet = decisionView({
      formula: {
        maestro: 0,
        portero_si: false,
        motivo: 'el maestro no está fuerte',
      },
      formula_action: 'ESPERAR',
      model_action: 'ESPERAR',
      opinion_agrees: 1,
    })
    expect(quiet.kind).toBe('wait')
    expect(quiet.relevant).toBe(false)
  })

  it('marks a disagreement as relevant and a missing opinion as none', () => {
    expect(
      decisionView({
        formula_action: 'MANTENER',
        model_action: 'CERRAR',
        opinion_agrees: 0,
      }),
    ).toMatchObject({
      kind: 'hold',
      relevant: true,
      opinion: { state: 'differs', label: 'cerrar' },
    })
    expect(
      decisionView({ formula_action: 'CERRAR', opinion_error: 'modelo_lento' })
        .opinion?.state,
    ).toBe('none')
  })

  it('keeps older rows honest from their action and skipped looks apart', () => {
    expect(decisionView({ action: 'SHORT' }).kind).toBe('enter-short')
    expect(decisionView({ action: 'CLOSE' }).kind).toBe('exit')
    expect(
      decisionView({ action: 'WAIT', reason_code: 'qwen_MANTENER' }).kind,
    ).toBe('hold')
    expect(decisionView({ action: 'WAIT', qwen_skipped: true }).kind).toBe(
      'skipped',
    )
    expect(decisionView({ action: 'WAIT' }).opinion).toBeNull()
  })

  it('draws the master as arrows', () => {
    expect([2, 1, 0, -1, -2, null].map(masterGlyph)).toEqual([
      '▲▲',
      '▲',
      '–',
      '▼',
      '▼▼',
      '?',
    ])
  })
})
