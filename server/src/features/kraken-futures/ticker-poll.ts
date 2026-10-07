import {
  readBoundedBody,
  type HistoricalFundingFetch,
} from './historical-funding.ts'

const URL = 'https://futures.kraken.com/derivatives/api/v3/tickers'
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const PRODUCT = /^PF_[A-Z0-9]{2,20}$/
/** Epoch of REST-polled tickers: apart from the WebSocket's 1.. epochs. */
export const REST_TICKER_EPOCH = 1_000_000

type Json = Record<string, unknown>

export type RestTickerEvent = Readonly<{
  type: 'ticker'
  productId: string
  seq: number
  epoch: number
  eventTime: number
  receivedAt: number
  persistedAt: number
  last?: string
  bid?: string
  ask?: string
  mark?: string
  index?: string
  suspended: boolean
  funding:
    | { status: 'unknown' }
    | { status: 'observed'; rate: string; unit: 'provider-unresolved' }
  raw: Json
}>

function decimalText(value: unknown): string | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined
  const text = String(value)
  if (!/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return undefined
  const parsed = Number(text)
  if (!Number.isFinite(parsed)) return undefined
  // Plain decimal text, no exponent.
  return parsed.toLocaleString('en-US', {
    useGrouping: false,
    maximumFractionDigits: 20,
  })
}

/**
 * Turns Kraken's REST `tickers` response into ticker events of the requested
 * products, shaped like the WebSocket ones (bid/ask/mark plus `bid_size` and
 * `ask_size` in `raw`), so paper execution reads them the same way. A product
 * with a missing or crossed quote is skipped, never guessed.
 */
export function parseRestTickers(
  rawText: string,
  options: { products: readonly string[]; receivedAtMs: number },
): RestTickerEvent[] {
  const body: unknown = JSON.parse(rawText)
  if (
    typeof body !== 'object' ||
    body === null ||
    !Array.isArray((body as Json).tickers)
  )
    throw new TypeError('Invalid REST tickers response.')
  const wanted = new Set(options.products)
  const events: RestTickerEvent[] = []
  for (const item of (body as { tickers: unknown[] }).tickers) {
    if (typeof item !== 'object' || item === null) continue
    const ticker = item as Json
    const symbol = ticker.symbol
    if (
      typeof symbol !== 'string' ||
      !PRODUCT.test(symbol) ||
      !wanted.has(symbol)
    )
      continue
    const bid = decimalText(ticker.bid)
    const ask = decimalText(ticker.ask)
    const mark = decimalText(ticker.markPrice)
    if (bid === undefined || ask === undefined || mark === undefined) continue
    if (!(Number(bid) > 0 && Number(bid) < Number(ask))) continue
    const funding = decimalText(ticker.fundingRate)
    events.push({
      type: 'ticker',
      productId: symbol,
      seq: options.receivedAtMs,
      epoch: REST_TICKER_EPOCH,
      eventTime: options.receivedAtMs,
      receivedAt: options.receivedAtMs,
      persistedAt: options.receivedAtMs,
      last: decimalText(ticker.last),
      bid,
      ask,
      mark,
      index: decimalText(ticker.indexPrice),
      suspended: ticker.suspended === true,
      funding:
        funding === undefined
          ? { status: 'unknown' }
          : { status: 'observed', rate: funding, unit: 'provider-unresolved' },
      raw: {
        feed: 'ticker',
        source: 'rest',
        product_id: symbol,
        bid_size: decimalText(ticker.bidSize) ?? null,
        ask_size: decimalText(ticker.askSize) ?? null,
        funding_rate: funding ?? null,
        relative_funding_rate: decimalText(ticker.relativeFundingRate) ?? null,
      },
    })
  }
  return events
}

export function createTickerPollClient(
  options: {
    fetch?: HistoricalFundingFetch
    clock?: () => number
    timeoutMs?: number
  } = {},
) {
  const clock = options.clock ?? Date.now
  const fetcher =
    options.fetch ?? ((input, init) => globalThis.fetch(input, init))
  const timeoutMs = options.timeoutMs ?? 5_000
  const controllers = new Set<AbortController>()
  return {
    async fetch(products: readonly string[]): Promise<RestTickerEvent[]> {
      const controller = new AbortController()
      controllers.add(controller)
      const timeout = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const response = await fetcher(URL, {
          method: 'GET',
          headers: { accept: 'application/json' },
          signal: controller.signal,
        })
        if (!response.ok)
          throw new Error(`REST tickers HTTP ${response.status}.`)
        const bytes = await readBoundedBody(
          response,
          MAX_RESPONSE_BYTES,
          'REST tickers response',
        )
        return parseRestTickers(
          new TextDecoder('utf-8', { fatal: true }).decode(bytes),
          {
            products,
            receivedAtMs: clock(),
          },
        )
      } finally {
        clearTimeout(timeout)
        controllers.delete(controller)
      }
    },
    close(): void {
      for (const controller of controllers) controller.abort()
      controllers.clear()
    },
  }
}
