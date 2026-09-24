import type {
  ForecastOutcomeLabel,
  TimestampMs,
} from '../../domain/contracts.ts'
import { contentHashFor } from '../forecasts/forecast-hashing.ts'
import {
  momentumBaseline,
  uniformBaseline,
  type BaselineProbabilities,
} from './baselines.ts'

/**
 * Deterministic LONG/FLAT trade simulation over closed 1m candles
 * (spot BTC, no shorts). Descriptive only: it never previews, submits, or
 * executes orders; it only replays signals into a hypothetical ledger.
 *
 * No-look-ahead rule: the signal observed at closed candle N fills at the
 * open of candle N+1. A position change decided at the last candle never
 * fills because no next open exists. Candles without a signal hold the
 * current position; an explicit abstention exits to flat.
 */
export const STRATEGY_RULE_VERSION = 'strategy-rule.v2' as const

export const TRADE_COSTS_VERSION = 'costs.v1' as const

export const DEFAULT_ENTRY_THRESHOLD = 0.55 as const

export const DEFAULT_EXIT_UP_THRESHOLD = 0.45 as const

export const DEFAULT_EXIT_DOWN_THRESHOLD = 0.55 as const

export const DEFAULT_STARTING_CASH = 10_000 as const

export interface TradeSimCosts {
  readonly commissionRate: number
  readonly slippageRate: number
}

export const DEFAULT_TRADE_COSTS: TradeSimCosts = {
  commissionRate: 0.001,
  slippageRate: 0.0005,
}

export interface TradeSimBar {
  /** Closed-candle bucket end; joins 1:1 with the signal time. */
  readonly time: TimestampMs
  readonly open: number
  readonly close: number
}

export interface TradeSimSignal {
  /** Closed-candle bucket end the forecast was issued at. */
  readonly time: TimestampMs
  readonly probabilityUp: number
  readonly probabilityDown: number
  readonly abstained: boolean
  /** Micro candidates supply their explicit target; legacy signals omit it. */
  readonly directTarget?: Position
}

export interface TradeSimFill {
  readonly time: TimestampMs
  readonly side: 'buy' | 'sell'
  readonly price: number
  readonly qty: number
  readonly commission: number
}

export interface TradeSimEquityPoint {
  readonly time: TimestampMs
  readonly equity: number
}

export interface TradeSimMetrics {
  /** (finalEquity - startingCash) / startingCash * 100. */
  readonly netReturnPct: number
  /** Closed LONG/FLAT round-trips. */
  readonly tradeCount: number
  /** Buy and sell order fills; an open terminal position contributes one fill. */
  readonly fillCount: number
  /** Profitable round-trips / closed round-trips; null without closes. */
  readonly winRate: number | null
  /** Gross net gains / absolute gross net losses on closed round-trips. Null when there are no losses. */
  readonly profitFactor: number | null
  /** Peak-to-trough decline over per-candle equity marks, in percent. */
  readonly maxDrawdownPct: number
  /** Candles held long / total candles; null on an empty window. */
  readonly exposurePct: number | null
  readonly finalEquity: number
}

export interface TradeSimResult {
  readonly fills: readonly TradeSimFill[]
  readonly equityCurve: readonly TradeSimEquityPoint[]
  readonly metrics: TradeSimMetrics
  readonly ledgerHash: string
}

export interface TradeSimOptions {
  readonly bars: readonly TradeSimBar[]
  readonly signals: readonly TradeSimSignal[]
  readonly startingCash?: number
  readonly entryThreshold?: number
  readonly exitUpThreshold?: number
  readonly exitDownThreshold?: number
  readonly costs?: TradeSimCosts
}

type Position = 'flat' | 'long'

function resolveOptions(options: TradeSimOptions): {
  readonly startingCash: number
  readonly entryThreshold: number
  readonly exitUpThreshold: number
  readonly exitDownThreshold: number
  readonly costs: TradeSimCosts
} {
  const startingCash = options.startingCash ?? DEFAULT_STARTING_CASH
  if (!Number.isFinite(startingCash) || startingCash <= 0) {
    throw new Error('Starting cash must be a finite positive amount.')
  }
  const entryThreshold = options.entryThreshold ?? DEFAULT_ENTRY_THRESHOLD
  const exitUpThreshold = options.exitUpThreshold ?? DEFAULT_EXIT_UP_THRESHOLD
  const exitDownThreshold =
    options.exitDownThreshold ?? DEFAULT_EXIT_DOWN_THRESHOLD
  for (const [name, value] of [
    ['entry', entryThreshold],
    ['exit-up', exitUpThreshold],
    ['exit-down', exitDownThreshold],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0 || value >= 1) {
      throw new Error(
        `Trade ${name} threshold must be a finite fraction strictly between 0 and 1.`,
      )
    }
  }
  if (!(exitUpThreshold < entryThreshold)) {
    throw new Error(
      'Trade exit-up threshold must be below the entry threshold.',
    )
  }
  const costs = options.costs ?? DEFAULT_TRADE_COSTS
  for (const [name, value] of [
    ['commission', costs.commissionRate],
    ['slippage', costs.slippageRate],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(
        `Trade ${name} rate must be a finite non-negative number.`,
      )
    }
  }
  return {
    startingCash,
    entryThreshold,
    exitUpThreshold,
    exitDownThreshold,
    costs,
  }
}

function decideTarget(
  signal: TradeSimSignal | undefined,
  current: Position,
  thresholds: {
    readonly entryThreshold: number
    readonly exitUpThreshold: number
    readonly exitDownThreshold: number
  },
): Position {
  if (signal?.directTarget !== undefined) return signal.directTarget
  if (signal === undefined) return current
  if (
    signal.abstained ||
    signal.probabilityUp < thresholds.exitUpThreshold ||
    signal.probabilityDown >= thresholds.exitDownThreshold
  ) {
    return 'flat'
  }
  if (signal.probabilityUp >= thresholds.entryThreshold) return 'long'
  return current
}

/**
 * Replay LONG/FLAT signals into a hypothetical full-position ledger.
 * One closed round-trip is a buy fill followed by its sell fill; an open
 * position at the end of the window is marked to the last close and counts
 * toward equity and exposure but never toward trade count or win rate.
 */
export function simulateLongFlat(options: TradeSimOptions): TradeSimResult {
  const {
    startingCash,
    entryThreshold,
    exitUpThreshold,
    exitDownThreshold,
    costs,
  } = resolveOptions(options)
  const { bars, signals } = options
  const signalByTime = new Map<TimestampMs, TradeSimSignal>()
  for (const signal of signals) signalByTime.set(signal.time, signal)

  const fills: TradeSimFill[] = []
  const equityCurve: TradeSimEquityPoint[] = []
  let position: Position = 'flat'
  let cash = startingCash
  let qty = 0
  let costBasis = 0
  let closedCount = 0
  let profitableCloses = 0
  let grossGains = 0
  let grossLosses = 0
  let longBars = 0
  let peak = startingCash
  let maxDrawdown = 0

  let pending: Position | null = null
  for (const bar of bars) {
    // Execute the preceding CLOSED candle's decision at this candle's open.
    // Mark-to-market below uses this candle's close, never the previous close.
    if (pending !== null && pending !== position) {
      if (pending === 'long') {
        const price = bar.open * (1 + costs.slippageRate)
        const nextQty = cash / (price * (1 + costs.commissionRate))
        const commission = nextQty * price * costs.commissionRate
        cash = 0
        qty = nextQty
        costBasis = nextQty * price + commission
        fills.push({
          time: bar.time,
          side: 'buy',
          price,
          qty: nextQty,
          commission,
        })
        position = 'long'
      } else {
        const price = bar.open * (1 - costs.slippageRate)
        const proceeds = qty * price * (1 - costs.commissionRate)
        const commission = qty * price * costs.commissionRate
        fills.push({ time: bar.time, side: 'sell', price, qty, commission })
        closedCount += 1
        const pnl = proceeds - costBasis
        if (pnl > 0) {
          profitableCloses += 1
          grossGains += pnl
        } else {
          grossLosses -= pnl
        }
        cash = proceeds
        qty = 0
        costBasis = 0
        position = 'flat'
      }
    }
    if (position === 'long') longBars += 1
    const equity = cash + qty * bar.close
    equityCurve.push({ time: bar.time, equity })
    if (equity > peak) peak = equity
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak)
    pending = decideTarget(signalByTime.get(bar.time), position, {
      entryThreshold,
      exitUpThreshold,
      exitDownThreshold,
    })
  }

  const finalEquity = equityCurve.at(-1)?.equity ?? startingCash
  const metrics: TradeSimMetrics = {
    netReturnPct: ((finalEquity - startingCash) / startingCash) * 100,
    tradeCount: closedCount,
    fillCount: fills.length,
    winRate: closedCount === 0 ? null : profitableCloses / closedCount,
    profitFactor: grossLosses === 0 ? null : grossGains / grossLosses,
    maxDrawdownPct: maxDrawdown * 100,
    exposurePct: bars.length === 0 ? null : (longBars / bars.length) * 100,
    finalEquity,
  }
  const ledgerHash = contentHashFor({
    ruleVersion: STRATEGY_RULE_VERSION,
    costsVersion: TRADE_COSTS_VERSION,
    startingCash,
    entryThreshold,
    exitUpThreshold,
    exitDownThreshold,
    costs,
    bars,
    signals,
    fills,
    equityCurve,
    metrics,
  })
  return { fills, equityCurve, metrics, ledgerHash }
}

/**
 * Buy-and-hold over the window: full-position buy fills at the first
 * candle open (as if decided before the window start) and sells at the
 * last candle close, with the same versioned costs on both legs.
 */
export function simulateBuyAndHold(options: {
  readonly bars: readonly TradeSimBar[]
  readonly startingCash?: number
  readonly costs?: TradeSimCosts
}): TradeSimResult {
  const { startingCash, costs } = resolveOptions({
    bars: options.bars,
    signals: [],
    ...(options.startingCash === undefined
      ? {}
      : { startingCash: options.startingCash }),
    ...(options.costs === undefined ? {} : { costs: options.costs }),
  })
  const bars = options.bars
  if (bars.length === 0) {
    return simulateLongFlat({ bars, signals: [], startingCash, costs })
  }
  const first = bars[0]!
  const last = bars.at(-1)!
  const buyPrice = first.open * (1 + costs.slippageRate)
  const qty = startingCash / (buyPrice * (1 + costs.commissionRate))
  const buyCommission = qty * buyPrice * costs.commissionRate
  const sellPrice = last.close * (1 - costs.slippageRate)
  const sellCommission = qty * sellPrice * costs.commissionRate
  const proceeds = qty * sellPrice * (1 - costs.commissionRate)
  const fills: TradeSimFill[] = [
    {
      time: first.time,
      side: 'buy',
      price: buyPrice,
      qty,
      commission: buyCommission,
    },
    {
      time: last.time,
      side: 'sell',
      price: sellPrice,
      qty,
      commission: sellCommission,
    },
  ]
  const equityCurve: TradeSimEquityPoint[] = bars.map((bar) => ({
    time: bar.time,
    // Marked long until the last close, where the hypothetical exit fills.
    equity: bar.time === last.time ? proceeds : qty * bar.close,
  }))
  const metrics: TradeSimMetrics = {
    netReturnPct: ((proceeds - startingCash) / startingCash) * 100,
    tradeCount: 1,
    fillCount: fills.length,
    winRate: proceeds > startingCash ? 1 : 0,
    profitFactor: proceeds < startingCash ? 0 : null,
    maxDrawdownPct: maxDrawdownOf(
      equityCurve.map((point) => point.equity),
      startingCash,
    ),
    exposurePct: 100,
    finalEquity: proceeds,
  }
  const ledgerHash = contentHashFor({
    ruleVersion: STRATEGY_RULE_VERSION,
    costsVersion: TRADE_COSTS_VERSION,
    baseline: 'buy-and-hold',
    startingCash,
    costs,
    bars,
    fills,
    equityCurve,
    metrics,
  })
  return { fills, equityCurve, metrics, ledgerHash }
}

function maxDrawdownOf(
  equities: readonly number[],
  startingCash: number,
): number {
  let peak = startingCash
  let maxDrawdown = 0
  for (const equity of equities) {
    if (equity > peak) peak = equity
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak)
  }
  return maxDrawdown * 100
}

function probabilitiesToSignal(
  time: TimestampMs,
  probabilities: BaselineProbabilities,
): TradeSimSignal {
  return {
    time,
    probabilityUp: probabilities.probabilityUp,
    probabilityDown: probabilities.probabilityDown,
    abstained: false,
  }
}

/** Uniform baseline signals: always (1/3, 1/3, 1/3), so the rule stays flat. */
export function uniformSignalsFor(
  bars: readonly TradeSimBar[],
): TradeSimSignal[] {
  return bars.map((bar) => probabilitiesToSignal(bar.time, uniformBaseline()))
}

/**
 * Momentum baseline signals: repeat the last observed outcome label with
 * certainty (the same rule as the forecast-accuracy momentum baseline).
 * The first bar has no previous label and falls back to uniform (flat).
 */
export function momentumSignalsFor(
  bars: readonly TradeSimBar[],
  labels: readonly (ForecastOutcomeLabel | null | undefined)[],
): TradeSimSignal[] {
  return bars.map((bar, index) =>
    probabilitiesToSignal(
      bar.time,
      momentumBaseline(index === 0 ? null : (labels[index - 1] ?? null)),
    ),
  )
}
