import { describe, expect, it } from 'vitest'
import { lifecycleView } from './terminal-lifecycle.ts'
import type { QwenTrade } from './useQwenTrades.ts'

const HOUR = 3_600_000
const NOW = Date.UTC(2026, 10, 1, 14, 0)

const look = (
  at: number,
  action: string,
  formula: Record<string, unknown>,
) => ({
  analysis_id: `qwen:PF_ETHUSD:${at}`,
  decision_time_ms: at,
  formula_action: action,
  formula,
})

const trade = (over: Partial<QwenTrade> = {}): QwenTrade =>
  ({
    product: 'PF_ETHUSD',
    tradeNo: 2,
    open: true,
    side: 'SHORT',
    entryMs: NOW - 5 * HOUR,
    ...over,
  }) as QwenTrade

describe('lifecycleView', () => {
  it('is null before Qwen has looked', () => {
    expect(
      lifecycleView({ analyses: [], openTrade: null, nowMs: NOW }),
    ).toBeNull()
  })

  it('shows the five entry steps when nothing is open and says who stopped', () => {
    const view = lifecycleView({
      analyses: [
        look(NOW - 900_000, 'ESPERAR', {
          maestro: -2,
          puntaje: -1.5,
          portero_si: false,
          portero_p: 0.38,
          portero_autonomo: { side: 1 },
          noticias_si: false,
          noticias: { priority: { status: 'none' } },
          motivo: 'maestro y portero autónomo no coinciden',
        }),
      ],
      openTrade: null,
      nowMs: NOW,
    })!
    expect(view.phase).toBe('entry')
    expect(view.steps.map((step) => step.id)).toEqual([
      'look',
      'master',
      'gate',
      'news',
      'enter',
    ])
    const tone = Object.fromEntries(view.steps.map((s) => [s.id, s.tone]))
    expect(view.steps.find((step) => step.id === 'news')?.word).toBe(
      'sin señal',
    )
    expect(view.steps.at(-1)?.word).toBe('en espera')
    expect(tone).toEqual({
      look: 'ok',
      master: 'ok',
      gate: 'no',
      news: 'na',
      enter: 'na',
    })
  })

  it('marks the entry as passed when the formulas enter', () => {
    const view = lifecycleView({
      analyses: [
        look(NOW, 'CORTO', {
          maestro: -2,
          portero_si: true,
          portero_autonomo: { side: -1 },
          noticias_si: false,
        }),
      ],
      openTrade: null,
      nowMs: NOW,
    })!
    expect(view.steps.at(-1)).toMatchObject({ id: 'enter', tone: 'ok' })
  })

  it('shows the six exit steps while an operation is open', () => {
    const view = lifecycleView({
      analyses: [
        look(NOW, 'MANTENER', {
          maestro: -2,
          puntaje: -1.2,
          noticias_si: false,
        }),
      ],
      openTrade: trade(),
      nowMs: NOW,
    })!
    expect(view.phase).toBe('exit')
    expect(view.steps.map((step) => step.id)).toEqual([
      'flip',
      'news12',
      'exhaust24',
      'cap',
      'maker',
      'emergency',
    ])
    expect(view.steps[0]).toMatchObject({ tone: 'ok' })
    expect(view.steps[1]).toMatchObject({ tone: 'na' })
    expect(view.steps[2]).toMatchObject({ tone: 'na' })
  })

  it('flags the master turning against the position', () => {
    const view = lifecycleView({
      analyses: [look(NOW, 'CERRAR', { maestro: 1, puntaje: 0.5 })],
      openTrade: trade(),
      nowMs: NOW,
    })!
    expect(view.steps[0]).toMatchObject({ id: 'flip', tone: 'no' })
  })

  it('applies the 24 h rule only after 24 h and the cap after 36 h', () => {
    const at = (hours: number) =>
      lifecycleView({
        analyses: [look(NOW, 'MANTENER', { maestro: -2, puntaje: 0.2 })],
        openTrade: trade({ entryMs: NOW - hours * HOUR }),
        nowMs: NOW,
      })!.steps
    expect(at(10)[2]!.tone).toBe('na')
    expect(at(25)[2]!.tone).toBe('no')
    expect(at(25)[3]!.tone).toBe('ok')
    expect(at(37)[3]!.tone).toBe('warn')
  })

  it('arms the 12 h news rule only for an entry that came through the news', () => {
    const entry = NOW - 3 * HOUR
    const analyses = (news: boolean) => [
      look(entry, 'CORTO', {
        maestro: -2,
        portero_si: false,
        noticias_si: news,
      }),
      look(NOW, 'MANTENER', { maestro: -1, puntaje: -0.5 }),
    ]
    const step = (news: boolean) =>
      lifecycleView({
        analyses: analyses(news),
        openTrade: trade({ entryMs: entry }),
        nowMs: NOW,
      })!.steps[1]!
    expect(step(true).tone).toBe('no')
    expect(step(false).tone).toBe('na')
  })

  it('reads the resting maker order and keeps its history empty', () => {
    const view = lifecycleView({
      analyses: [
        look(NOW - 900_000, 'MANTENER', { maestro: -2 }),
        look(NOW, 'MANTENER', { maestro: -2 }),
      ],
      openTrade: trade({
        execution: {
          exitPlan: {
            mode: 'sigue',
            startedMs: NOW - 19 * 60_000,
            ttlMs: 45 * 60_000,
            topeBp: 40,
            price: 2190,
            reprices: 2,
            outcome: null,
            endedMs: null,
          },
        } as QwenTrade['execution'],
      }),
      nowMs: NOW,
    })!
    const maker = view.steps.find((step) => step.id === 'maker')!
    expect(maker.tone).toBe('info')
    expect(maker.history).toEqual([])
    expect(maker.meter?.value).toBeCloseTo(19 / 45)
  })
})

describe('lifecycleView · decisión óptima', () => {
  const MIN = 60_000
  // A price that rises 20 bp every 10 minutes from 30 minutes before NOW.
  const rising = Array.from({ length: 120 }, (_, i) => ({
    timeMs: NOW - (119 - i) * MIN,
    close: 2000 * (1 + (i * 2) / 10_000),
  }))
  const strongShort = (at: number) =>
    look(at, 'CORTO', {
      maestro: -2,
      puntaje: -1.4,
      portero_si: true,
      portero_p: 0.6,
      portero_autonomo: { side: -1 },
      noticias_si: false,
      noticias: { priority: { status: 'none' } },
    })

  it('judges a strong call 30 minutes later: wrong when the price went the other way', () => {
    const view = lifecycleView({
      analyses: [strongShort(NOW - 90 * MIN)],
      openTrade: null,
      nowMs: NOW,
      prices: rising,
    })!
    const master = view.steps.find((step) => step.id === 'master')!
    expect(master.checks).toHaveLength(1)
    expect(master.checks![0]).toMatchObject({ state: 'wrong' })
    expect(master.checks![0]!.moveBp).toBeGreaterThan(0)
  })

  it('leaves a look of the last 30 minutes pending and a fixed rule without a row', () => {
    const view = lifecycleView({
      analyses: [strongShort(NOW - 10 * MIN)],
      openTrade: null,
      nowMs: NOW,
      prices: rising,
    })!
    expect(view.steps.find((s) => s.id === 'master')!.checks![0]!.state).toBe(
      'pending',
    )
    expect(view.steps.find((s) => s.id === 'look')!.checks).toBeNull()
  })

  it('counts a "no entrar" as right when the move did not cover the costs', () => {
    const flat = rising.map((p) => ({ ...p, close: 2000 }))
    const view = lifecycleView({
      analyses: [
        look(NOW - 90 * MIN, 'ESPERAR', {
          maestro: 1,
          puntaje: 0.3,
          portero_si: false,
          noticias_si: false,
        }),
      ],
      openTrade: null,
      nowMs: NOW,
      prices: flat,
    })!
    expect(view.steps.find((s) => s.id === 'enter')!.checks![0]!.state).toBe(
      'right',
    )
  })

  it('judges the exit rules by the open position and skips looks before it opened', () => {
    const view = lifecycleView({
      analyses: [
        look(NOW - 100 * MIN, 'MANTENER', { maestro: -2 }),
        look(NOW - 90 * MIN, 'MANTENER', { maestro: -2 }),
      ],
      openTrade: trade({ entryMs: NOW - 95 * MIN }),
      nowMs: NOW,
      prices: rising,
    })!
    const flip = view.steps.find((step) => step.id === 'flip')!
    expect(flip.checks!.map((check) => check.state)).toEqual(['none', 'wrong'])
    expect(view.steps.find((s) => s.id === 'cap')!.checks).toBeNull()
  })
})

describe('lifecycleView · veredicto del auditor', () => {
  const MIN = 60_000
  const rising = Array.from({ length: 120 }, (_, i) => ({
    timeMs: NOW - (119 - i) * MIN,
    close: 2000 * (1 + (i * 2) / 10_000),
  }))
  const verdict = (acerto: boolean | null, texto: string) => ({
    acerto,
    costo_error_pb: 0,
    regla: 'x',
    texto,
  })
  // A strong short that the 30 minute judge calls wrong (the price rose).
  const strongShort = (at: number, auditoria?: unknown) => ({
    ...look(at, 'CORTO', {
      maestro: -2,
      puntaje: -1.4,
      portero_si: true,
      portero_p: 0.6,
      portero_autonomo: { side: -1 },
      noticias_si: false,
      noticias: { priority: { status: 'none' } },
    }),
    auditoria,
  })
  const masterCheck = (auditoria?: unknown) =>
    lifecycleView({
      analyses: [strongShort(NOW - 90 * MIN, auditoria)],
      openTrade: null,
      nowMs: NOW,
      prices: rising,
    })!.steps.find((step) => step.id === 'master')!.checks![0]!

  it('takes the 36 h verdict over the 24 h and 12 h ones', () => {
    expect(
      masterCheck({
        accion: 'ENTRAR',
        veredicto_12h: verdict(false, 'quedaba: −41 pb'),
        veredicto_24h: verdict(false, 'quedaba: −10 pb'),
        veredicto_36h: verdict(true, 'ganó +58 pb'),
      }),
    ).toEqual({
      state: 'right',
      atMs: NOW - 90 * MIN,
      moveBp: null,
      source: 'auditor_36h',
      text: 'ganó +58 pb',
    })
  })

  it('uses the 12 h verdict while it is the only one, and 24 h when 36 h is missing', () => {
    expect(
      masterCheck({ veredicto_12h: verdict(false, 'quedaba: −41 pb') }),
    ).toMatchObject({
      state: 'wrong',
      source: 'auditor_12h',
      text: 'quedaba: −41 pb',
    })
    expect(
      masterCheck({
        veredicto_12h: verdict(false, 'a'),
        veredicto_24h: verdict(true, 'b'),
        veredicto_36h: null,
      }),
    ).toMatchObject({ state: 'right', source: 'auditor_24h', text: 'b' })
  })

  it('falls back to the 30 minute judge without an auditor verdict', () => {
    const empty = {
      accion: 'ENTRAR',
      veredicto_12h: null,
      veredicto_24h: null,
      veredicto_36h: null,
    }
    for (const auditoria of [undefined, null, empty]) {
      const check = masterCheck(auditoria)
      expect(check).toMatchObject({
        state: 'wrong',
        source: '30min',
        text: null,
      })
      expect(check.moveBp).toBeGreaterThan(0)
    }
  })

  it('reads a fixed rule (acerto null) as none, not as a 30 minute verdict', () => {
    expect(
      masterCheck({ veredicto_36h: verdict(null, 'regla fija') }),
    ).toMatchObject({
      state: 'none',
      source: 'auditor_36h',
      text: 'regla fija',
    })
  })

  it('applies the verdict of the look to the exit steps of an open operation', () => {
    const view = lifecycleView({
      analyses: [
        {
          ...look(NOW - 90 * MIN, 'MANTENER', { maestro: -2 }),
          auditoria: { veredicto_12h: verdict(true, 'ganó +58 pb') },
        },
      ],
      openTrade: trade({ entryMs: NOW - 95 * MIN }),
      nowMs: NOW,
      prices: rising,
    })!
    expect(view.steps.find((s) => s.id === 'flip')!.checks![0]).toMatchObject({
      state: 'right',
      source: 'auditor_12h',
    })
  })
})
