import { useEffect, useState } from 'react'
import { record } from '../shared/wire/decode.ts'

const POLL_MS = 15_000

/** One operation of Qwen operador (paper), as the gateway serves it. */
export interface QwenTrade {
  product: string
  tradeNo: number
  open: boolean
  side: 'LONG' | 'SHORT'
  entryMs: number
  exitMs: number | null
  entryPrice: number | null
  exitPrice: number | null
  /** Closed: the final net. Open: what closing now would net, costs included. */
  netUsd: number | null
  feesUsd: number | null
  fundingUsd: number | null
  fundingComplete: boolean
  closedBy: string | null
  holdMin: number | null
  markPrice: number | null
  notionalUsd: number | null
  leverage: number | null
  marginUsd: number | null
}

export type QwenTradesSource =
  | { state: 'loading' }
  | { state: 'ok' }
  | { state: 'off'; reason: string }
  | { state: 'error' }

const number = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** The trades of a `/api/qwen/trades` answer; anything malformed is left out. */
export function qwenTrades(payload: unknown): QwenTrade[] {
  const body = record(payload)
  if (body.status !== 'ok' || !Array.isArray(body.trades)) return []
  return body.trades.map(record).flatMap((row) => {
    const entryMs = number(row.entry_ms)
    const tradeNo = number(row.trade_no)
    if (
      typeof row.product !== 'string' ||
      entryMs === null ||
      tradeNo === null ||
      (row.side !== 'LONG' && row.side !== 'SHORT')
    )
      return []
    return [
      {
        product: row.product,
        tradeNo,
        open: row.status === 'open',
        side: row.side,
        entryMs,
        exitMs: number(row.exit_ms),
        entryPrice: number(row.entry_price),
        exitPrice: number(row.exit_price),
        netUsd: number(row.net_usd),
        feesUsd: number(row.fees_usd),
        fundingUsd: number(row.funding_usd),
        fundingComplete: row.funding_status === 'complete',
        closedBy: typeof row.closed_by === 'string' ? row.closed_by : null,
        holdMin: number(row.hold_min),
        markPrice: number(row.mark_price),
        notionalUsd: number(row.notional_usd),
        leverage: number(row.leverage),
        marginUsd: number(row.margin_usd),
      },
    ]
  })
}

const NONE: QwenTrade[] = []
const LOADING: QwenTradesSource = { state: 'loading' }

/** Qwen operador's paper trades of one product (read-only, polled). */
export function useQwenTrades(
  product: string | undefined,
  enabled: boolean,
): { trades: QwenTrade[]; source: QwenTradesSource } {
  const [read, setRead] = useState<{
    product: string
    trades: QwenTrade[]
    source: QwenTradesSource
  } | null>(null)
  useEffect(() => {
    if (!enabled || !product) return
    const controller = new AbortController()
    const load = async () => {
      try {
        const response = await fetch(
          `/api-live/qwen/trades?product=${encodeURIComponent(product)}&limit=50`,
          { signal: controller.signal },
        )
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const body = await response.json()
        const status = record(body).status
        setRead({
          product,
          trades: qwenTrades(body),
          source:
            status === 'ok'
              ? { state: 'ok' }
              : { state: 'off', reason: String(record(body).reason ?? '') },
        })
      } catch {
        if (!controller.signal.aborted)
          setRead({ product, trades: NONE, source: { state: 'error' } })
      }
    }
    void load()
    const timer = setInterval(() => void load(), POLL_MS)
    return () => {
      controller.abort()
      clearInterval(timer)
    }
  }, [product, enabled])
  return enabled && read && read.product === product
    ? { trades: read.trades, source: read.source }
    : { trades: NONE, source: LOADING }
}
