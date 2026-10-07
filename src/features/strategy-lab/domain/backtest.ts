import {
  isCondition,
  type Condition,
  type RuleNode,
  type Side,
  type StrategySpec,
} from './strategy-spec.ts'
import {
  computeFeatures,
  regimes,
  type FeatureRow,
  type LabCandle,
} from './indicators.ts'

export type LabTrade = {
  side: Side
  entryTime: number
  exitTime: number
  entryPrice: number
  exitPrice: number
  /** Net of fees, as a fraction of the position notional. */
  netReturn: number
  netUsd: number
  exitReason: 'stop' | 'target' | 'rule' | 'horizon' | 'end'
  strategyId: string
}

export type LabResult = {
  trades: LabTrade[]
  returnPct: number
  netUsd: number
  wins: number
  losses: number
  hitRatePct: number | null
  maxDrawdownPct: number
  avgWinUsd: number | null
  avgLossUsd: number | null
}

export type BacktestOptions = {
  initialCash?: number
  /** Taker fee per side. Kraken Futures' public taker tier is 0.05 %. */
  feeRate?: number
  /** Resolves a C28-style adapter's delegate by id. */
  resolve?: (id: string) => StrategySpec | undefined
}

const DEFAULT_CASH = 10_000
const DEFAULT_FEE = 0.0005

function operandValue(
  operand: string,
  row: FeatureRow,
  params: Record<string, string>,
): number | undefined {
  if (operand.startsWith('$')) {
    const param = params[operand.slice(1)]
    return param === undefined ? undefined : Number(param)
  }
  if (/^-?\d+(?:\.\d+)?$/.test(operand)) return Number(operand)
  return row[operand]
}

/** Whether one condition holds; undefined while an operand is not ready. */
export function evaluateCondition(
  condition: Condition,
  row: FeatureRow,
  params: Record<string, string>,
): boolean | undefined {
  const left = operandValue(condition.left, row, params)
  let right = operandValue(condition.right, row, params)
  if (condition.scale !== undefined && right !== undefined) {
    const scale = operandValue(condition.scale, row, params)
    right = scale === undefined ? undefined : right * scale
  }
  if (left === undefined || right === undefined) return undefined
  if (condition.op === '>') return left > right
  if (condition.op === '>=') return left >= right
  if (condition.op === '<') return left < right
  return left <= right
}

export function evaluateNode(
  node: RuleNode,
  row: FeatureRow,
  params: Record<string, string>,
): boolean {
  if (isCondition(node)) return evaluateCondition(node, row, params) === true
  if ('all' in node)
    return (
      node.all.length > 0 &&
      node.all.every((child) => evaluateNode(child, row, params))
    )
  if ('any' in node)
    return node.any.some((child) => evaluateNode(child, row, params))
  return !evaluateNode(node.not, row, params)
}

/** Each condition of a side against the newest candle, for the editor. */
export function lastCandleStates(
  conditions: readonly Condition[],
  candles: readonly LabCandle[],
  params: Record<string, string>,
): Array<boolean | undefined> {
  const rows = computeFeatures(candles)
  const row = rows.at(-1)
  return conditions.map((condition) =>
    row ? evaluateCondition(condition, row, params) : undefined,
  )
}

function regimeAllows(spec: StrategySpec, regime: string): boolean {
  return spec.regime.length === 0 || spec.regime.includes(regime as never)
}

/** The spec that decides at a candle: itself, or an adapter's delegate. */
function decidingSpec(
  spec: StrategySpec,
  regime: 'trend' | 'range' | 'unknown',
  resolve: BacktestOptions['resolve'],
): StrategySpec | undefined {
  if (!spec.delegate) return spec
  if (regime === 'unknown') return undefined
  const id = spec.delegate[regime]
  return id ? resolve?.(id) : undefined
}

/**
 * In-browser preview backtest: enters at the close of the candle whose
 * features satisfy a side, exits at the stop or target (stop first when one
 * candle touches both), when the side's exit rule holds at a close, at the
 * horizon, or at the last candle. One position at a time, the whole equity
 * as notional, fees on both sides. Not the official walk-forward of PS-08d.
 */
export function runBacktest(
  spec: StrategySpec,
  candles: readonly LabCandle[],
  options: BacktestOptions = {},
): LabResult {
  const initialCash = options.initialCash ?? DEFAULT_CASH
  const fee = options.feeRate ?? DEFAULT_FEE
  const rows = computeFeatures(candles)
  const regime = regimes(rows)
  const trades: LabTrade[] = []
  let equity = initialCash
  let peak = equity
  let maxDrawdown = 0

  let open:
    | {
        side: Side
        spec: StrategySpec
        index: number
        price: number
        stop: number
        target: number
      }
    | undefined

  const close = (
    index: number,
    price: number,
    reason: LabTrade['exitReason'],
  ) => {
    if (!open) return
    const direction = open.side === 'LONG' ? 1 : -1
    const gross = (direction * (price - open.price)) / open.price
    const netReturn = gross - 2 * fee
    const netUsd = equity * netReturn
    equity += netUsd
    peak = Math.max(peak, equity)
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak)
    trades.push({
      side: open.side,
      entryTime: candles[open.index]!.time,
      exitTime: candles[index]!.time,
      entryPrice: open.price,
      exitPrice: price,
      netReturn,
      netUsd,
      exitReason: reason,
      strategyId: open.spec.id,
    })
    open = undefined
  }

  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index]!
    const row = rows[index]!
    if (open) {
      const long = open.side === 'LONG'
      const hitStop = long ? candle.low <= open.stop : candle.high >= open.stop
      const hitTarget = long
        ? candle.high >= open.target
        : candle.low <= open.target
      const exitRule = open.spec.exit[open.side]
      const minutes = (candle.time - candles[open.index]!.time) / 60
      if (hitStop) close(index, open.stop, 'stop')
      else if (hitTarget) close(index, open.target, 'target')
      else if (exitRule && evaluateNode(exitRule, row, open.spec.params))
        close(index, candle.close, 'rule')
      else if (
        open.spec.horizon_minutes > 0 &&
        minutes >= open.spec.horizon_minutes
      )
        close(index, candle.close, 'horizon')
      continue
    }
    const deciding = decidingSpec(spec, regime[index]!, options.resolve)
    if (!deciding || !regimeAllows(deciding, regime[index]!)) continue
    const range = row['1m.atr14']
    if (!range) continue
    for (const side of ['LONG', 'SHORT'] as const) {
      const rule = deciding.entry[side]
      if (!rule || !evaluateNode(rule, row, deciding.params)) continue
      const stopDistance = Number(deciding.risk.stop_atr) * range
      const targetDistance = Number(deciding.risk.target_atr) * range
      const long = side === 'LONG'
      open = {
        side,
        spec: deciding,
        index,
        price: candle.close,
        stop: long ? candle.close - stopDistance : candle.close + stopDistance,
        target: long
          ? candle.close + targetDistance
          : candle.close - targetDistance,
      }
      break
    }
  }
  if (open) close(candles.length - 1, candles.at(-1)!.close, 'end')
  return summarize(trades, initialCash, equity, maxDrawdown)
}

export function summarize(
  trades: readonly LabTrade[],
  initialCash: number,
  finalEquity: number,
  maxDrawdown: number,
): LabResult {
  const winners = trades.filter((trade) => trade.netUsd > 0)
  const losers = trades.filter((trade) => trade.netUsd <= 0)
  const mean = (list: readonly LabTrade[]) =>
    list.length === 0
      ? null
      : list.reduce((sum, trade) => sum + trade.netUsd, 0) / list.length
  return {
    trades: [...trades],
    returnPct: ((finalEquity - initialCash) / initialCash) * 100,
    netUsd: finalEquity - initialCash,
    wins: winners.length,
    losses: losers.length,
    hitRatePct:
      trades.length === 0 ? null : (winners.length / trades.length) * 100,
    maxDrawdownPct: maxDrawdown * 100,
    avgWinUsd: mean(winners),
    avgLossUsd: mean(losers),
  }
}

/** Buy and hold over the same candles, one round trip of fees. */
export function buyAndHold(
  candles: readonly LabCandle[],
  options: BacktestOptions = {},
): LabResult {
  const initialCash = options.initialCash ?? DEFAULT_CASH
  const fee = options.feeRate ?? DEFAULT_FEE
  const first = candles[0]
  const last = candles.at(-1)
  if (!first || !last) return summarize([], initialCash, initialCash, 0)
  let peak = first.close
  let maxDrawdown = 0
  for (const candle of candles) {
    peak = Math.max(peak, candle.high)
    maxDrawdown = Math.max(maxDrawdown, (peak - candle.low) / peak)
  }
  const netReturn = (last.close - first.close) / first.close - 2 * fee
  const result = summarize(
    [],
    initialCash,
    initialCash * (1 + netReturn),
    maxDrawdown,
  )
  return { ...result, hitRatePct: null }
}
