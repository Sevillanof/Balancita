import type { TerminalBootstrap } from '../features/connected-trading/infrastructure/terminal-stream-client.ts'
import { record } from '../shared/wire/decode.ts'

type RecordValue = Record<string, unknown>

export function projectTerminalQuote(input: {
  mode: TerminalBootstrap['mode']
  market: RecordValue
  terminalMarket: RecordValue
  position: RecordValue | null
  /** Base asset of the quoted product (default BTC). */
  base?: string
}): {
  price: string | null
  label: string
  eventTime: number | null
  receivedAt: number | null
} {
  const base = input.base ?? 'BTC'
  if (input.mode === 'paper_live') {
    const normalized = record(input.market.normalized)
    const isTrade = input.market.feed === 'trade'
    const isTicker = input.market.feed === 'ticker'
    const tradePrice = isTrade ? decimal(normalized.priceUsd) : null
    const tickerLast = isTicker ? decimal(normalized.last) : null
    const tickerMark = isTicker ? decimal(normalized.mark) : null
    const price = tradePrice ?? tickerLast ?? tickerMark
    const label = tradePrice
      ? `Último trade público · ${base}/USD`
      : tickerLast
        ? `Último ticker público · ${base}/USD`
        : tickerMark
          ? `Mark público · ${base}/USD`
          : `Precio público no disponible · ${base}/USD`
    return {
      price,
      label,
      eventTime: safeTime(input.market.event_time),
      receivedAt: safeTime(input.market.received_at),
    }
  }

  const positionMark = decimal(input.position?.mark_usd_per_btc)
  const lastCandle = Array.isArray(input.terminalMarket.candles)
    ? record(input.terminalMarket.candles.at(-1))
    : {}
  const candleClose = decimal(lastCandle.close)
  return {
    price: positionMark ?? candleClose,
    label: positionMark
      ? `Precio de marca · ${base}/USD`
      : `Último cierre del fixture · ${base}/USD`,
    eventTime: null,
    receivedAt: null,
  }
}

function decimal(value: unknown): string | null {
  return typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)
    ? value
    : null
}

function safeTime(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : null
}
