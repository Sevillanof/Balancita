import { useEffect, useState } from 'react'
import { record } from '../shared/wire/decode.ts'

const POLL_MS = 15_000

/** The resting exit order: still waiting (`outcome` null), filled as maker, or sent to market (`mercado:<why>`). */
export interface QwenExitPlan {
  mode: 'fija' | 'sigue'
  startedMs: number
  ttlMs: number
  topeBp: number
  price: number
  reprices: number
  outcome: string | null
  endedMs: number | null
}

export interface QwenExecutionPhase {
  receiptId: string
  costModelHash: string
  feeKind: 'taker' | 'maker'
  price: number
  quantity: number
  feeUsd: number
  feeRate: number
  sourceUrl: string
  signalMs: number
  decisionMs: number
  requestedMs: number
  receivedMs: number
  serverMs: number
  executedMs: number
}

export interface QwenExecution {
  model: string
  entry: QwenExecutionPhase
  exit: QwenExecutionPhase | null
  mark: QwenExecutionPhase | null
  fundingReceiptId: string | null
  error: string | null
  exitPlan: QwenExitPlan | null
}

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
  fundingModel?: string | null
  netCompleteUsd?: number | null
  configHash?: string | null
  markMs?: number | null
  closedBy: string | null
  holdMin: number | null
  markPrice: number | null
  notionalUsd: number | null
  leverage: number | null
  marginUsd: number | null
  execution?: QwenExecution | null
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

function executionPhase(value: unknown): QwenExecutionPhase | null {
  const row = record(value)
  const price = number(row.price)
  const quantity = number(row.quantity)
  const feeUsd = number(row.fee_usd)
  const feeRate = number(row.fee_rate)
  const feeKind = row.fee_kind
  const times = [
    row.signal_at_ms,
    row.decision_at_ms,
    row.requested_at_ms,
    row.received_at_ms,
    row.server_at_ms,
    row.executed_at_ms,
  ]
  if (
    typeof row.receipt_id !== 'string' ||
    !/^[a-f0-9]{64}$/.test(row.receipt_id) ||
    typeof row.cost_model_hash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(row.cost_model_hash) ||
    (feeKind !== 'taker' && feeKind !== 'maker') ||
    row.source !==
      'https://futures.kraken.com/derivatives/api/v3/orderbook?symbol=PF_ETHUSD' ||
    price === null ||
    price <= 0 ||
    quantity === null ||
    quantity <= 0 ||
    feeUsd === null ||
    feeUsd < 0 ||
    feeRate === null ||
    feeRate < 0 ||
    feeRate >= 1 ||
    !times.every(
      (time) =>
        typeof time === 'number' && Number.isSafeInteger(time) && time > 0,
    )
  )
    return null
  const out: QwenExecutionPhase = {
    receiptId: row.receipt_id,
    costModelHash: row.cost_model_hash,
    feeKind,
    price,
    quantity,
    feeUsd,
    feeRate,
    sourceUrl: row.source,
    signalMs: Number(row.signal_at_ms),
    decisionMs: Number(row.decision_at_ms),
    requestedMs: Number(row.requested_at_ms),
    receivedMs: Number(row.received_at_ms),
    serverMs: Number(row.server_at_ms),
    executedMs: Number(row.executed_at_ms),
  }
  if (
    out.signalMs > out.decisionMs ||
    out.decisionMs > out.executedMs ||
    out.requestedMs > out.receivedMs ||
    out.receivedMs > out.executedMs
  )
    return null
  return out
}

function exitPlanOf(value: unknown): QwenExitPlan | null {
  const row = record(value)
  const price = number(row.price)
  const topeBp = number(row.tope_bp)
  const times = [row.started_ms, row.ttl_ms]
  if (
    (row.mode !== 'fija' && row.mode !== 'sigue') ||
    price === null ||
    price <= 0 ||
    topeBp === null ||
    topeBp <= 0 ||
    !times.every((time) => typeof time === 'number' && time > 0) ||
    typeof row.reprices !== 'number' ||
    row.reprices < 0 ||
    (row.outcome != null && typeof row.outcome !== 'string') ||
    (row.ended_ms != null && typeof row.ended_ms !== 'number')
  )
    return null
  return {
    mode: row.mode,
    startedMs: Number(row.started_ms),
    ttlMs: Number(row.ttl_ms),
    topeBp,
    price,
    reprices: row.reprices,
    outcome: typeof row.outcome === 'string' ? row.outcome : null,
    endedMs: typeof row.ended_ms === 'number' ? row.ended_ms : null,
  }
}

function executionOf(value: unknown): QwenExecution | null {
  const row = record(value)
  const entry = executionPhase(row.entry)
  const exit = row.exit == null ? null : executionPhase(row.exit)
  const mark = row.mark == null ? null : executionPhase(row.mark)
  const exitPlan = row.exit_plan == null ? null : exitPlanOf(row.exit_plan)
  if (row.exit_plan != null && exitPlan === null) return null
  if (
    row.model !== 'kraken-futures-book.v1' ||
    entry === null ||
    (row.exit != null && exit === null) ||
    (row.mark != null && mark === null) ||
    (row.error != null && typeof row.error !== 'string') ||
    (row.funding_receipt_id != null &&
      (typeof row.funding_receipt_id !== 'string' ||
        !/^[a-f0-9]{64}$/.test(row.funding_receipt_id)))
  )
    return null
  return {
    model: row.model,
    entry,
    exit,
    mark,
    fundingReceiptId:
      typeof row.funding_receipt_id === 'string'
        ? row.funding_receipt_id
        : null,
    error: typeof row.error === 'string' ? row.error : null,
    exitPlan,
  }
}

/** The trades of a `/api/qwen/trades` answer; anything malformed is left out. */
export function qwenTrades(payload: unknown): QwenTrade[] {
  const body = record(payload)
  if (body.status !== 'ok' || !Array.isArray(body.trades)) return []
  return body.trades.map(record).flatMap((row) => {
    const entryMs = number(row.entry_ms)
    const tradeNo = number(row.trade_no)
    const execution = row.execution == null ? null : executionOf(row.execution)
    if (
      typeof row.product !== 'string' ||
      entryMs === null ||
      tradeNo === null ||
      (row.status !== 'open' && row.status !== 'closed') ||
      (row.side !== 'LONG' && row.side !== 'SHORT') ||
      (row.execution != null && execution === null) ||
      (execution !== null &&
        (row.product !== 'PF_ETHUSD' ||
          execution.entry.executedMs !== entryMs ||
          execution.entry.price !== number(row.entry_price) ||
          (row.status === 'closed' && execution.exit === null) ||
          (execution.error !== null && row.net_usd != null)))
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
        fundingModel:
          typeof row.funding_model === 'string' ? row.funding_model : null,
        netCompleteUsd:
          row.funding_status === 'complete'
            ? number(row.net_complete_usd)
            : null,
        configHash:
          typeof row.config_hash === 'string' ? row.config_hash : null,
        markMs: number(row.mark_ms),
        closedBy: typeof row.closed_by === 'string' ? row.closed_by : null,
        holdMin: number(row.hold_min),
        markPrice: number(row.mark_price),
        notionalUsd: number(row.notional_usd),
        leverage: number(row.leverage),
        marginUsd: number(row.margin_usd),
        execution,
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
        const rows = record(body).trades
        const parsed = qwenTrades(body)
        if (
          status === 'ok' &&
          (!Array.isArray(rows) || parsed.length !== rows.length)
        )
          throw new Error('Invalid operations response')
        setRead((previous) => ({
          product,
          trades:
            status === 'ok'
              ? parsed
              : previous?.product === product
                ? previous.trades
                : NONE,
          source:
            status === 'ok'
              ? { state: 'ok' }
              : { state: 'off', reason: String(record(body).reason ?? '') },
        }))
      } catch {
        if (!controller.signal.aborted)
          setRead((previous) => ({
            product,
            trades: previous?.product === product ? previous.trades : NONE,
            source: { state: 'error' },
          }))
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
