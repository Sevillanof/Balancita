import { describe, expect, it } from 'vitest'
import { exitPlanText } from './qwen-trades-text.ts'
import type { QwenExitPlan, QwenTrade } from './useQwenTrades.ts'
import { usd } from '../shared/finance/format.ts'

const PRICE = usd(2498.2)

const phase = {
  receiptId: 'a'.repeat(64),
  costModelHash: 'b'.repeat(64),
  feeKind: 'taker' as const,
  price: 100,
  quantity: 1,
  feeUsd: 0.05,
  feeRate: 0.0005,
  sourceUrl: '',
  signalMs: 1,
  decisionMs: 1,
  requestedMs: 1,
  receivedMs: 1,
  serverMs: 1,
  executedMs: 1,
}

function tradeWith(plan: QwenExitPlan | null, side: 'LONG' | 'SHORT' = 'LONG') {
  return {
    side,
    execution: {
      model: 'kraken-futures-book.v1',
      entry: phase,
      exit: null,
      mark: null,
      fundingReceiptId: null,
      error: null,
      exitPlan: plan,
    },
  } as unknown as QwenTrade
}

const plan: QwenExitPlan = {
  mode: 'sigue',
  startedMs: 0,
  ttlMs: 2_700_000,
  topeBp: 40,
  price: 2498.2,
  reprices: 3,
  outcome: null,
  endedMs: null,
}

describe('exitPlanText', () => {
  it('says nothing when the trade never waited', () => {
    expect(exitPlanText(tradeWith(null), 0)).toBeNull()
  })

  it('describes an order that is still waiting, per side', () => {
    expect(exitPlanText(tradeWith(plan), 12 * 60_000)).toBe(
      `Orden de venta esperando a ${PRICE} (movida 3 veces, hace 12 min). Sale a mercado a los 45 min, si el precio se aleja 40 pb o ante una emergencia.`,
    )
    expect(
      exitPlanText(tradeWith({ ...plan, reprices: 0 }, 'SHORT'), 30_000),
    ).toContain(
      `Orden de compra esperando a ${PRICE} (sin moverla, hace menos de 1 min)`,
    )
  })

  it('describes how it ended: maker or market and why', () => {
    const done = { ...plan, endedMs: 5 * 60_000 }
    expect(exitPlanText(tradeWith({ ...done, outcome: 'maker' }), 0)).toBe(
      `Salió como maker a ${PRICE} (movida 3 veces; esperó 5 min).`,
    )
    expect(
      exitPlanText(tradeWith({ ...done, outcome: 'mercado:tope' }), 0),
    ).toContain('Salió a mercado porque el precio se alejó más del tope')
    expect(
      exitPlanText(
        tradeWith({ ...done, outcome: 'mercado:emergencia_stop' }),
        0,
      ),
    ).toContain('una emergencia (stop o noticia fuerte)')
  })
})
