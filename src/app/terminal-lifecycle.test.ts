import { describe, expect, it } from 'vitest'
import { lifecycleView } from './terminal-lifecycle.ts'
import type { QwenTrade, QwenTradeAudit } from './useQwenTrades.ts'

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
      'auditor',
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
      auditor: 'na',
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

  it('shows the seven exit steps while an operation is open', () => {
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
      'auditor',
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

describe('lifecycleView · paso Auditor', () => {
  const verdict = (
    acerto: boolean | null,
    texto: string | null,
    costoErrorPb = 0,
  ) => ({ acerto, costoErrorPb, texto })
  const audit = (over: Partial<QwenTradeAudit> = {}): QwenTradeAudit => ({
    entrada: null,
    entradaHorizonte: null,
    entradaAccion: 'ENTRAR',
    salida: null,
    salidaHorizonte: null,
    salidaAccion: null,
    mantener: { aciertos: 0, total: 0 },
    miradas: 1,
    ...over,
  })
  const closed = (tradeNo: number, over: Partial<QwenTrade> = {}) =>
    trade({
      tradeNo,
      open: false,
      entryMs: NOW - (60 - tradeNo * 10) * HOUR,
      exitMs: NOW - (50 - tradeNo * 10) * HOUR,
      netUsd: -12.9,
      ...over,
    })
  const hold = (at: number, auditoria?: unknown) => ({
    ...look(at, 'MANTENER', { maestro: -2, puntaje: -1.2, noticias_si: false }),
    auditoria,
  })
  const stepOf = (
    trades: QwenTrade[],
    openTrade: QwenTrade | null = null,
    analyses: unknown[] = [hold(NOW)],
  ) =>
    lifecycleView({ analyses, openTrade, nowMs: NOW, trades })!.steps.find(
      (step) => step.id === 'auditor',
    )!

  it('is second to last in both phases', () => {
    const entry = lifecycleView({
      analyses: [look(NOW, 'ESPERAR', { maestro: 0 })],
      openTrade: null,
      nowMs: NOW,
    })!
    expect(entry.steps.at(-2)?.id).toBe('auditor')
    expect(entry.steps.at(-1)?.id).toBe('enter')
    const exit = lifecycleView({
      analyses: [hold(NOW)],
      openTrade: trade(),
      nowMs: NOW,
    })!
    expect(exit.steps.at(-2)?.id).toBe('auditor')
    expect(exit.steps.at(-1)?.id).toBe('emergency')
  })

  it('has no judgments before the auditor has seen any operation', () => {
    const step = stepOf([closed(1), closed(2, { auditoria: null })])
    expect(step).toMatchObject({
      icon: 'audit',
      label: 'Auditor',
      tone: 'na',
      word: 'sin juicios',
      judgments: [],
      flatJudgments: [],
      rows: [],
      checks: null,
      meter: null,
    })
    expect(step.headline).toBe(
      'Todavía no hay juicios (el primero llega 12 h después de la primera mirada)',
    )
  })

  it('judges the last operation with the definitive verdicts and totals the cost of errors', () => {
    const step = stepOf([
      closed(1, {
        auditoria: audit({
          entrada: verdict(true, 'si entraba: +23 pb'),
          entradaHorizonte: '36h',
          salida: verdict(true, 'quedaban −8 pb'),
          salidaHorizonte: '36h',
          salidaAccion: 'SALIR_vuelta',
        }),
      }),
      closed(2, {
        side: 'SHORT',
        auditoria: audit({
          entrada: verdict(true, 'si entraba: +9 pb'),
          entradaHorizonte: '36h',
          salida: verdict(false, 'quedaban +41 pb', 41),
          salidaHorizonte: '36h',
          salidaAccion: 'SALIR_vuelta',
          mantener: { aciertos: 7, total: 9 },
        }),
      }),
    ])
    expect(step).toMatchObject({ tone: 'no', word: 'falló' })
    expect(step.headline).toBe(
      'Últimas 2 operaciones: 2 entradas y 1 salida acertada · errores costaron 41 pb',
    )
    expect(step.rows).toEqual([
      {
        label: 'Operación',
        value: expect.stringMatching(/^#2 corto, \d+-\w+ \d\d:\d\d$/),
      },
      { label: 'Entrada', value: 'si entraba: +9 pb · acertó' },
      { label: 'Salida', value: 'quedaban +41 pb · falló' },
      { label: 'Mantener', value: '7 de 9 miradas acertadas' },
    ])
    expect(step.judgments!.map((j) => j.tradeNo)).toEqual([1, 2])
    expect(step.judgments![1]).toMatchObject({
      id: 'terminal:PF_ETHUSD:2',
      entrada: { state: 'right', provisional: false },
      salida: { state: 'wrong', text: 'quedaban +41 pb', provisional: false },
      mantener: { aciertos: 7, total: 9 },
    })
  })

  it('marks 12 h verdicts as provisional and an open operation as pending', () => {
    const step = stepOf(
      [
        closed(1, {
          auditoria: audit({
            entrada: verdict(true, 'si entraba: +9 pb'),
            entradaHorizonte: '12h',
            salidaAccion: 'SALIR_24h',
          }),
        }),
        trade({ tradeNo: 3, auditoria: audit() }),
      ],
      trade({ tradeNo: 3, auditoria: audit() }),
    )
    const [done, open] = step.judgments!
    expect(done!.entrada).toMatchObject({ state: 'right', provisional: true })
    // Seen by the auditor but without a verdict yet.
    expect(done!.salida).toMatchObject({ state: 'pending' })
    expect(open).toMatchObject({ tradeNo: 3, open: true })
    expect(open!.entrada.state).toBe('pending')
    // Last judged operation has nothing decided: pending.
    expect(step).toMatchObject({ tone: 'info', word: 'pendiente' })
    expect(step.rows.find((r) => r.label === 'Mantener')?.value).toBe(
      'sin miradas juzgadas',
    )
  })

  it('reads a fixed rule as none and the last decided mark sets the tone', () => {
    const step = stepOf([
      closed(1, {
        auditoria: audit({
          entrada: verdict(true, 'si entraba: +9 pb'),
          entradaHorizonte: '36h',
          salida: verdict(null, null),
          salidaHorizonte: '36h',
          salidaAccion: 'SALIR_36h',
        }),
      }),
    ])
    expect(step.judgments![0]!.salida).toMatchObject({
      state: 'none',
      text: 'regla fija, no se juzga',
    })
    expect(step).toMatchObject({ tone: 'ok', word: 'acertó' })
    expect(step.headline).toBe(
      'Última operación: 1 entrada y 0 salidas acertadas · sin errores',
    )
  })

  it('keeps only the last 8 judged operations, oldest first', () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      closed(i + 1, {
        entryMs: NOW - (100 - i) * HOUR,
        auditoria: audit({
          entrada: verdict(true, 'x'),
          entradaHorizonte: '36h',
        }),
      }),
    )
    const step = stepOf(many.reverse())
    expect(step.judgments!.map((j) => j.tradeNo)).toEqual([
      3, 4, 5, 6, 7, 8, 9, 10,
    ])
  })

  it('lists only the judged looks that did not enter in flatJudgments', () => {
    const flat = (at: number, accion: string, auditoria?: unknown) => ({
      ...look(at, 'ESPERAR', { maestro: 1, noticias_si: false }),
      auditoria:
        auditoria === undefined
          ? {
              accion,
              veredicto_12h: null,
              veredicto_24h: null,
              veredicto_36h: null,
              despues: null,
            }
          : auditoria,
    })
    const judged = {
      accion: 'NO_ENTRAR_portero',
      veredicto_12h: { acerto: false, texto: 'quedaba +41 pb' },
      veredicto_24h: null,
      veredicto_36h: null,
      despues: null,
    }
    const step = stepOf([], null, [
      flat(NOW - 4 * HOUR, 'NO_ENTRAR_portero', judged),
      // Not judged yet: no verdict at any horizon.
      flat(NOW - 3 * HOUR, 'NO_ENTRAR_maestro'),
      // A hold is not a look without an operation.
      hold(NOW - 2 * HOUR, {
        accion: 'MANTENER',
        veredicto_12h: { acerto: true, texto: 'bien' },
        veredicto_24h: null,
        veredicto_36h: null,
        despues: null,
      }),
      flat(NOW - HOUR, 'NO_ENTRAR_maestro', {
        ...judged,
        accion: 'NO_ENTRAR_maestro',
        veredicto_36h: { acerto: true, texto: 'no ganaba' },
      }),
    ])
    expect(step.flatJudgments).toEqual([
      {
        state: 'wrong',
        atMs: NOW - 4 * HOUR,
        moveBp: null,
        source: 'auditor_12h',
        text: 'quedaba +41 pb',
      },
      {
        state: 'right',
        atMs: NOW - HOUR,
        moveBp: null,
        source: 'auditor_36h',
        text: 'no ganaba',
      },
    ])
    // The looks without an operation do not set the step's tone.
    expect(step.tone).toBe('na')
  })
})
