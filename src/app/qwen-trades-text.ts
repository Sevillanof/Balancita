import type { QwenTrade, QwenTradesSource } from './useQwenTrades.ts'
import { usd } from '../shared/finance/format.ts'

export function signedUsd(value: number | null): string {
  if (value === null) return 'no disponible'
  return `${new Intl.NumberFormat('es-ES', {
    style: 'currency',
    currency: 'USD',
    signDisplay: 'always',
  }).format(value)}`
}

/** Text when Qwen has no operations to show, or null. */
export function qwenTradesNotice(
  source: QwenTradesSource,
  rows: number,
): string | null {
  if (rows > 0 || source.state === 'loading') return null
  if (source.state === 'off')
    return 'Qwen no está operando: todavía no hay base de operaciones. Se crea sola cuando arranca pnpm dev con el modelo local instalado.'
  if (source.state === 'error')
    return 'No se pudieron leer las operaciones de Qwen del gateway.'
  return 'Qwen todavía no operó. Mira el mercado cada 15 minutos y solo opera si ve una ventaja clara.'
}

const MARKET_REASON: Record<string, string> = {
  tope: 'el precio se alejó más del tope',
  tiempo: 'pasó el tiempo máximo de espera',
  libro: 'el libro estuvo caído',
}

const minutesText = (ms: number): string =>
  ms < 60_000 ? 'menos de 1 min' : `${Math.round(ms / 60_000)} min`

/**
 * How the exit of a trade is going or went, in one sentence: an order still waiting (and how many times it moved), a
 * maker exit, or the market exit that replaced the order (and why). Null when the trade never waited.
 */
export function exitPlanText(trade: QwenTrade, nowMs: number): string | null {
  const plan = trade.execution?.exitPlan
  if (!plan) return null
  const order = trade.side === 'LONG' ? 'venta' : 'compra'
  const moved =
    plan.reprices === 0
      ? 'sin moverla'
      : `movida ${plan.reprices} ${plan.reprices === 1 ? 'vez' : 'veces'}`
  if (plan.outcome === null)
    return `Orden de ${order} esperando a ${usd(plan.price)} (${moved}, hace ${minutesText(nowMs - plan.startedMs)}). Sale a mercado a los ${minutesText(plan.ttlMs)}, si el precio se aleja ${plan.topeBp} pb o ante una emergencia.`
  const waited = minutesText((plan.endedMs ?? nowMs) - plan.startedMs)
  if (plan.outcome === 'maker')
    return `Salió como maker a ${usd(plan.price)} (${moved}; esperó ${waited}).`
  const why = plan.outcome.replace('mercado:', '')
  const reason = why.startsWith('emergencia')
    ? 'una emergencia (stop o noticia fuerte)'
    : (MARKET_REASON[why] ?? why)
  return `Salió a mercado porque ${reason} (esperó ${waited}; ${moved}).`
}
