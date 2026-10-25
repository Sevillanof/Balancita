import { describe, expect, it } from 'vitest'
import {
  percent,
  probabilitiesText,
  skippedReason,
  waitReason,
} from './qwen-wait-reason.ts'
import { qwenAnalyses } from './useQwenDecisions.ts'
import { analysisReason } from './terminal-labels.ts'

const flat = {
  chosen: 'ESPERAR',
  kind: 'FLAT',
  threshold: 0.5,
  probabilities: { LARGO: 0.46, CORTO: 0.2, ESPERAR: 0.34 },
}

describe('waitReason', () => {
  it('says the entry wish that fell short of the minimum', () => {
    expect(
      waitReason({
        ...flat,
        override: 'bajo_umbral',
        model_action: 'LARGO',
        p_action: 0.46,
      }),
    ).toBe('Quiso entrar LARGO con 46 %, no llegó al 50 % mínimo.')
  })
  it('says the mirror contradicted it', () => {
    const text = waitReason({
      ...flat,
      override: 'espejo',
      model_action: 'CORTO',
      p_action: 0.7,
      mirror_action: 'CORTO',
      mirror_p: 0.6,
    })
    expect(text).toContain('el espejo lo contradijo')
    expect(text).toContain('CORTO con 70 %')
  })
  it('covers the other overrides and an unknown one', () => {
    expect(waitReason({ ...flat, override: 'espejo_sin_respuesta' })).toContain(
      'espejo no se pudo leer',
    )
    expect(waitReason({ ...flat, override: 'sin_respuesta' })).toContain(
      'no se pudo leer',
    )
    expect(
      waitReason({ chosen: 'LARGO', override: 'motivo_sin_respuesta' }),
    ).toContain('«otro»')
    expect(waitReason({ ...flat, override: 'algo_nuevo' })).toBe(
      'No operó (algo nuevo).',
    )
  })
  it('says a plain wait and a hold with their probability', () => {
    expect(
      waitReason({
        chosen: 'ESPERAR',
        probabilities: { LARGO: 0.2, CORTO: 0.18, ESPERAR: 0.62 },
      }),
    ).toBe('Esperó porque vio más probable esperar (62 %).')
    expect(
      waitReason({ chosen: 'MANTENER', probabilities: { MANTENER: 0.7 } }),
    ).toBe('Mantuvo la posición porque vio más probable mantener (70 %).')
    expect(waitReason({ chosen: 'ESPERAR' })).toBe(
      'Esperó porque no vio ventaja clara.',
    )
  })
  it('has nothing to say about an entry', () => {
    expect(waitReason({ chosen: 'LARGO' })).toBeNull()
  })
})

describe('helpers', () => {
  it('formats probabilities and skipped wakes', () => {
    expect(probabilitiesText(flat.probabilities)).toBe(
      'Largo 46 % · Corto 20 % · Esperar 34 %',
    )
    expect(probabilitiesText(null)).toBeNull()
    expect(percent('x')).toBeNull()
    expect(skippedReason('modelo_caido')).toContain('no respondió')
    expect(skippedReason('modelo_lento')).toContain('tardó')
    expect(skippedReason('proceso_detenido')).toContain('apagado')
    expect(skippedReason('rara', 'detalle')).toBe(
      'No decidió esta vez (detalle).',
    )
  })
})

describe('qwenAnalyses with reasons', () => {
  it('carries the reason and probabilities, and adds skipped wakes', () => {
    const out = qwenAnalyses({
      status: 'ok',
      decisions: [
        {
          product: 'PF_XBTUSD',
          bucket_start_ms: 0,
          decision_time_ms: 900_000,
          action: 'WAIT',
          chosen: 'ESPERAR',
          confidence: 0.3,
          override: 'bajo_umbral',
          model_action: 'LARGO',
          p_action: 0.46,
          threshold: 0.5,
          probabilities: flat.probabilities,
        },
      ],
      skipped: [
        {
          product: 'PF_XBTUSD',
          bucket_start_ms: 900_000,
          decision_time_ms: 1_800_000,
          reason: 'modelo_caido',
          detail: '',
        },
      ],
    })
    expect(out).toHaveLength(2)
    expect(analysisReason(out[0])).toContain('no llegó al 50 % mínimo')
    expect(out[0]!.qwen_probabilities).toBe(
      'Largo 46 % · Corto 20 % · Esperar 34 %',
    )
    expect(analysisReason(out[1])).toContain('el modelo local no respondió')
    expect(out[1]!.runtime_version).toBeUndefined()
  })
})

describe('waitReason: ventana de oportunidad', () => {
  it('dice cuánto vale la ocasión y cuál es la mejor hasta ahora', () => {
    const text = waitReason({
      chosen: 'ESPERAR',
      override: 'ventana_mirando',
      look_n: 4,
      score: 0.1234,
      best_score: 0.5,
      mirror_ok: 1,
    })
    expect(text).toContain('Mirando la mejor ocasión (mirada 4)')
    expect(text).toContain('vale 0,12')
    expect(text).toContain('mejor candidata hasta ahora vale 0,50')
  })

  it('dice que el espejo no coincidió y que no entra', () => {
    const text = waitReason({
      chosen: 'ESPERAR',
      override: 'ventana_mirando',
      lean_num: -0.3,
      mirror_ok: 0,
    })
    expect(text).toContain('Se inclinaba CORTO')
    expect(text).toContain('el espejo no coincidió')
  })

  it('cuenta la entrada y deja legible la entrada forzada vieja', () => {
    expect(
      waitReason({ chosen: 'LARGO', override: 'entrada_ventana', score: 0.31 }),
    ).toBe(
      'Entró LARGO en la ventana de oportunidad, con una ocasión de 0,31, con el espejo coincidiendo.',
    )
    expect(
      waitReason({ chosen: 'CORTO', override: 'entrada_forzada' }),
    ).toContain('Entró por inactividad')
  })
})
