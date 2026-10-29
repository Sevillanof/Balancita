import { useMemo, useState } from 'react'
import type {
  QuickRebote,
  ReboteTrade,
  ReboteVariant,
} from '../infrastructure/quick-api.ts'
import type { RunCandle, RunTrade } from '../infrastructure/run-visual-api.ts'

export type ReboteSize = 'compuesto' | 'fijo'

const candlesOf = (points: Array<[number, number]>): RunCandle[] =>
  points.map(([time_ms, close]) => ({
    time_ms,
    open: String(close),
    high: String(close),
    low: String(close),
    close: String(close),
    volume: '0',
  }))

/** One operation of the rebound analyst as the market chart reads it, sized the way the user picked. */
export function reboteTrade(
  trade: ReboteTrade,
  index: number,
  size: ReboteSize,
): RunTrade {
  const step = trade.cuenta[size]
  return {
    trade_id: `rebote-${index}`,
    product_id: trade.producto,
    side: 'LONG',
    entry_time_ms: trade.entrada_ms,
    entry_bucket_ms: null,
    entry_price: String(trade.entrada_px),
    exit_time_ms: trade.salida_ms,
    exit_bucket_ms: null,
    exit_price: String(trade.salida_px),
    exit_reason: trade.motivo,
    reason_code: null,
    net_bp: trade.neto_bp,
    pnl_usd: step.pnl_usd,
    funding_usd: null,
    funding_status: 'unknown',
    notional_usd: String(step.nocional_usd),
    signal_time_ms: trade.caida.hasta_ms,
    size_mult: null,
    with_movement: null,
    drop: {
      from_ms: trade.caida.desde_ms,
      to_ms: trade.caida.hasta_ms,
      pct: trade.caida.pct,
      btc_pct: trade.caida.btc_pct,
    },
  }
}

export type ReboteModel = {
  product: string
  variant: ReboteVariant
  setVariant: (id: ReboteVariant['id']) => void
  size: ReboteSize
  setSize: (size: ReboteSize) => void
  trades: RunTrade[]
  /** The candles on screen: hourly closes of the whole period, or 5-minute closes around the chosen operation. */
  candles: RunCandle[]
  closes: number[]
  selected: RunTrade | null
  select: (trade: RunTrade) => void
  showAll: () => void
  fromMs: number
  toMs: number
}

/**
 * What the panel of the rebound analyst draws: the operations of the chosen variant sized with the whole account or with
 * 100 USD, the hourly price of the period and, on a tap, the 5-minute price around that operation. `null` with no result.
 */
export function useReboteModel(rebote: QuickRebote | null): ReboteModel | null {
  const [variantId, setVariant] = useState<ReboteVariant['id']>('principal')
  const [size, setSize] = useState<ReboteSize>('compuesto')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const variant =
    rebote?.variantes.find((v) => v.id === variantId) ??
    rebote?.variantes[0] ??
    null
  const product = rebote?.producto ?? ''
  const points = useMemo(
    () => (rebote ? (rebote.mercado[product] ?? []) : []),
    [rebote, product],
  )
  const all = useMemo(() => candlesOf(points), [points])
  const trades = useMemo(
    () =>
      variant ? variant.operaciones.map((t, i) => reboteTrade(t, i, size)) : [],
    [variant, size],
  )
  const selected = trades.find((t) => t.trade_id === selectedId) ?? null
  const detail = selected
    ? (variant?.operaciones[Number(selected.trade_id.slice(7))]?.velas ?? [])
    : []
  const candles = selected && detail.length >= 2 ? candlesOf(detail) : all
  const closes = useMemo(() => points.map(([, close]) => close), [points])
  if (!rebote || !variant || all.length < 2) return null
  return {
    product,
    variant,
    setVariant: (id) => {
      setVariant(id)
      setSelectedId(null)
    },
    size,
    setSize,
    trades,
    candles,
    closes,
    selected,
    select: (trade) => setSelectedId(trade.trade_id),
    showAll: () => setSelectedId(null),
    fromMs: rebote.desde_ms,
    toMs: rebote.hasta_ms,
  }
}
