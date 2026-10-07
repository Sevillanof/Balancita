import type { TerminalEnvelope } from './terminal-stream-client.ts'
import { record } from '../../../shared/wire/decode.ts'

type TerminalState = Record<string, unknown>

export function applyTerminalEvent(
  previous: TerminalState | null,
  event: TerminalEnvelope,
): TerminalState {
  const state = { ...(previous ?? {}) }
  const data = event.data
  if (event.type === 'analysis.completed') {
    state.analyses = [
      ...(Array.isArray(state.analyses) ? state.analyses : []),
      { ...record(data.analysis) },
    ].slice(-500)
    state.state_version = Number(state.state_version ?? 0) + 1
  } else if (event.type === 'account.updated') state.account = data.account
  else if (event.type === 'position.updated') state.position = data.position
  else if (event.type === 'order.updated') {
    const orders = Array.isArray(state.orders) ? state.orders : []
    const nextOrder = record(data.order)
    const orderId = nextOrder.order_id
    const existingIndex =
      typeof orderId === 'string'
        ? orders.findIndex((order) => record(order).order_id === orderId)
        : -1
    state.orders =
      existingIndex < 0
        ? [...orders, data.order].slice(-500)
        : orders.map((order, index) =>
            index === existingIndex ? data.order : order,
          )
  } else if (event.type === 'fill.created') {
    const fills = Array.isArray(state.fills) ? state.fills : []
    const fillId = record(data.fill).fill_id
    if (
      typeof fillId !== 'string' ||
      !fills.some((fill) => record(fill).fill_id === fillId)
    )
      state.fills = [...fills, data.fill].slice(-500)
  } else if (event.type === 'market.updated') {
    const previousMarket = record(state.market)
    const candle = record(data.candle)
    const hasCandle =
      Number.isSafeInteger(candle.bucket_start_ms) &&
      Number.isSafeInteger(candle.interval_ms) &&
      typeof candle.closed === 'boolean'
    const priorTerminalMarket = record(state.terminal_market)
    const priorCandles = Array.isArray(priorTerminalMarket.candles)
      ? priorTerminalMarket.candles
      : []
    const nextCandles = hasCandle
      ? [
          ...priorCandles.filter(
            (item) => record(item).time_ms !== Number(candle.bucket_start_ms),
          ),
          {
            time_ms: Number(candle.bucket_start_ms),
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            volume_btc: candle.volume_btc,
            closed: candle.closed,
          },
        ]
          .sort(
            (left, right) =>
              Number(record(left).time_ms) - Number(record(right).time_ms),
          )
          .slice(-500)
      : priorCandles
    state.market = { ...previousMarket, ...data }
    state.terminal_market = {
      schema_version: 'futures-terminal-market.v1',
      as_of_ms: Math.max(
        Number(data.last_received_at ?? data.received_at ?? 0),
        Number(candle.known_at_ms ?? 0),
      ),
      interval_ms: 60_000,
      candles: nextCandles,
    }
  } else if (event.type === 'command.result') {
    const result = record(record(data.result).result)
    state.state_version = result.applied_state_version ?? state.state_version
  }
  return state
}
