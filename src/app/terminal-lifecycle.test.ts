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
