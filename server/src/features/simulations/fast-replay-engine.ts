import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { probabilitiesForShift } from './fixed-proportional-shift.ts'
import {
  evaluateMicroTarget,
  evaluateC27ExitWithMacroContext,
  initialMicroState,
  macroContextWhenReady,
  type MicroStrategyFeatures,
} from './micro-strategy.ts'

export const FAST_REPLAY_STRATEGIES = [
  'micro-trend-pullback',
  'micro-bollinger-reversion',
  'micro-donchian-breakout',
  'micro-regime-adapter',
] as const
export type FastReplayStrategyId = (typeof FAST_REPLAY_STRATEGIES)[number]
export interface FastReplayCandle {
  readonly timestamp: number
  readonly open: number
  readonly high: number
  readonly low: number
  readonly close: number
  readonly volume: number
}
export interface FastReplayTrade {
  readonly side: 'buy' | 'sell'
  readonly timestamp: number
  readonly price: number
  readonly quantity: number
  readonly feeEur: number
  readonly pnlEur?: number
}
export interface FastReplayResult {
  readonly strategyId: FastReplayStrategyId
  readonly candlesEvaluated: number
  readonly sampleCount: number
  readonly tradesCount: number
  readonly rawSignalsCount: number
  readonly gateRejectionsCount: number
  readonly winRatePct: number
  readonly profitFactor: number
  readonly netPnlEur: number
  readonly brierScoreMulticlass: number | null
  readonly baselineUniformBrier: 0.6667
  readonly baselineNoChangeBrier: number | null
  readonly trades: readonly FastReplayTrade[]
  readonly openPositionAtEnd: {
    readonly quantity: number
    readonly entryPrice: number
    readonly entryCostEur: number
  } | null
  readonly gaps: readonly number[]
  readonly executionTimeMs: number
}
const HORIZON = 1
export const FAST_REPLAY_FEE = 0.001
export const FAST_REPLAY_SLIPPAGE = 0.0005
export const FAST_REPLAY_COST_GATE = 0.006
const FEE = FAST_REPLAY_FEE
const SLIPPAGE = FAST_REPLAY_SLIPPAGE

export function fastReplayStrategyFor(
  id: FastReplayStrategyId,
):
  | 'trend-pullback'
  | 'bollinger-reversion'
  | 'donchian-breakout'
  | 'regime-adapter' {
  return id === 'micro-trend-pullback'
    ? 'trend-pullback'
    : id === 'micro-bollinger-reversion'
      ? 'bollinger-reversion'
      : id === 'micro-donchian-breakout'
        ? 'donchian-breakout'
        : 'regime-adapter'
}

export function runFastReplay(input: {
  readonly strategyId: string
  readonly candles: readonly FastReplayCandle[]
  readonly ticketEur: number
}): FastReplayResult {
  const started = performance.now()
  const strategyId =
    input.strategyId === 'donchian-volume-breakout'
      ? 'micro-donchian-breakout'
      : input.strategyId
  if (!(FAST_REPLAY_STRATEGIES as readonly string[]).includes(strategyId))
    throw new Error('Unsupported Fast Replay strategy.')
  if (!Number.isFinite(input.ticketEur) || input.ticketEur <= 0)
    throw new Error('ticket_eur must be finite and positive.')
  const minuteCandles = [...input.candles].sort(
    (a, b) => a.timestamp - b.timestamp,
  )
  validateCandles(minuteCandles)
  const gaps: number[] = []
  for (let i = 1; i < minuteCandles.length; i += 1)
    if (minuteCandles[i]!.timestamp - minuteCandles[i - 1]!.timestamp !== 60)
      gaps.push(minuteCandles[i]!.timestamp)
  if (gaps.length > 0)
    throw new Error(
      `OHLC dataset contains ${gaps.length} gap(s); Fast Replay requires contiguous 1-minute input.`,
    )
  const candles = resample1mTo15m(minuteCandles, Number.MAX_SAFE_INTEGER)
  const trades: FastReplayTrade[] = []
  const closedPnls: number[] = []
  const forecasts: {
    index: number
    probabilities: readonly [number, number, number]
  }[] = []
  const outcomes: { maturedAt: number; label: 'up' | 'down' | 'flat' }[] = []
  let state = initialMicroState()
  let position: {
    quantity: number
    entryCost: number
    buyTradeIndex: number
    entryPrice: number
    entryIndex: number
  } | null = null
  let grossWins = 0
  let grossLosses = 0
  let brierSum = 0
  let noChangeBrierSum = 0
  let sampleCount = 0
  let rawSignalsCount = 0
  let gateRejectionsCount = 0
  for (let index = 49; index < candles.length; index += 1) {
    const candle = candles[index]!
    const history = candles.slice(0, index + 1)
    const features = fastReplayFeaturesAt(history)
    const macro = features
    const strategy = fastReplayStrategyFor(strategyId as FastReplayStrategyId)
    const decision = evaluateMicroTarget(
      strategy,
      features,
      state,
      macroContextWhenReady(macro),
    )
    let effectiveTarget = decision.target
    if (state.exposure === 'flat' && decision.target === 'long') {
      rawSignalsCount += 1
      if (
        fastReplayCanEnter(
          strategyId as FastReplayStrategyId,
          features,
          decision.state.regime,
          macro,
        )
      ) {
        const next = candles[index + 1]
        if (next !== undefined && next.timestamp === candle.timestamp + 900) {
          const price = next.open * (1 + SLIPPAGE)
          const quantity = input.ticketEur / price
          const feeEur = input.ticketEur * FEE
          trades.push({
            side: 'buy',
            timestamp: next.timestamp,
            price,
            quantity,
            feeEur,
          })
          position = {
            quantity,
            entryCost: input.ticketEur + feeEur,
            buyTradeIndex: trades.length - 1,
            entryPrice: price,
            entryIndex: index + 1,
          }
          state = { ...decision.state, exposure: 'long' }
        } else {
          effectiveTarget = 'flat'
          state = { ...decision.state, exposure: 'flat' }
        }
      } else {
        gateRejectionsCount += 1
        effectiveTarget = 'flat'
        state = { ...decision.state, exposure: 'flat' }
      }
    } else if (
      position !== null &&
      (strategyId === 'micro-donchian-breakout'
        ? evaluateC27ExitWithMacroContext({
            entryPrice: position.entryPrice,
            close: candle.close,
            macroContext: macroContextWhenReady(macro),
            barsHeld: index - position.entryIndex + 1,
          }) !== 'hold'
        : decision.target === 'flat') &&
      state.exposure === 'long'
    ) {
      const next = candles[index + 1]
      if (next !== undefined && next.timestamp === candle.timestamp + 900) {
        const price = next.open * (1 - SLIPPAGE)
        const proceedsGross = position.quantity * price
        const feeEur = proceedsGross * FEE
        const pnlEur = proceedsGross - feeEur - position.entryCost
        trades.push({
          side: 'sell',
          timestamp: next.timestamp,
          price,
          quantity: position.quantity,
          feeEur,
          pnlEur,
        })
        closedPnls.push(pnlEur)
        if (pnlEur > 0) grossWins += pnlEur
        else grossLosses += Math.abs(pnlEur)
        position = null
        state = { ...decision.state, exposure: 'flat' }
      } else {
        effectiveTarget = 'long'
        state = { ...decision.state, exposure: 'long' }
      }
    } else {
      effectiveTarget = position === null ? 'flat' : 'long'
      state = { ...decision.state, exposure: effectiveTarget }
    }

    const dueIndex = index - HORIZON
    if (dueIndex >= 50) {
      const forecast = forecasts.find(
        ({ index: forecastIndex }) => forecastIndex === dueIndex,
      )
      const origin = candles[dueIndex]!
      const maturedReturn = candle.close / origin.close - 1
      const label =
        maturedReturn > 0.0015
          ? 'up'
          : maturedReturn < -0.0015
            ? 'down'
            : 'flat'
      outcomes.push({ maturedAt: candle.timestamp, label })
      if (forecast !== undefined) {
        const target =
          label === 'up' ? [1, 0, 0] : label === 'down' ? [0, 1, 0] : [0, 0, 1]
        const probability = forecast.probabilities
        brierSum += probability.reduce(
          (sum, value, part) => sum + (value - target[part]!) ** 2,
          0,
        )
        noChangeBrierSum += [0, 0, 1].reduce(
          (sum, value, part) => sum + (value - target[part]!) ** 2,
          0,
        )
        sampleCount += 1
      }
    }
    const priorOutcomes = outcomes.filter(
      ({ maturedAt }) => maturedAt < candle.timestamp,
    )
    const counts = { up: 0, down: 0, flat: 0 }
    for (const outcome of priorOutcomes) counts[outcome.label] += 1
    const total = priorOutcomes.length
    if (total > 0) {
      const prior = {
        up: counts.up / total,
        down: counts.down / total,
        flat: counts.flat / total,
      }
      forecasts.push({
        index,
        probabilities: Object.values(
          probabilitiesForShift(prior, effectiveTarget === 'long' ? 1 : 0),
        ) as [number, number, number],
      })
    }
  }
  return {
    strategyId: strategyId as FastReplayStrategyId,
    candlesEvaluated: candles.length,
    sampleCount,
    tradesCount: closedPnls.length,
    rawSignalsCount,
    gateRejectionsCount,
    winRatePct:
      closedPnls.length === 0
        ? 0
        : (closedPnls.filter((pnl) => pnl > 0).length / closedPnls.length) *
          100,
    profitFactor:
      grossLosses === 0
        ? grossWins > 0
          ? Number.POSITIVE_INFINITY
          : 0
        : grossWins / grossLosses,
    netPnlEur: closedPnls.reduce((sum, pnl) => sum + pnl, 0),
    brierScoreMulticlass: sampleCount === 0 ? null : brierSum / sampleCount,
    baselineUniformBrier: 0.6667,
    baselineNoChangeBrier:
      sampleCount === 0 ? null : noChangeBrierSum / sampleCount,
    trades,
    openPositionAtEnd:
      position === null
        ? null
        : {
            quantity: position.quantity,
            entryPrice: position.entryPrice,
            entryCostEur: position.entryCost,
          },
    gaps,
    executionTimeMs: performance.now() - started,
  }
}

export function fastReplayHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function fastReplayCanEnter(
  id: FastReplayStrategyId,
  features: MicroStrategyFeatures,
  activeRegime: 'trend' | 'range' | null,
  macroFeatures: MicroStrategyFeatures | null = null,
): boolean {
  void macroFeatures
  if (features.ready !== true) return false
  const distance =
    id === 'micro-trend-pullback'
      ? features.atr14 == null
        ? 0
        : (2 * features.atr14) / features.close
      : id === 'micro-bollinger-reversion'
        ? features.bollingerWidth == null
          ? 0
          : features.bollingerWidth / features.close
        : id === 'micro-donchian-breakout'
          ? features.donchianHigh20 == null || features.donchianLow20 == null
            ? 0
            : (features.donchianHigh20 - features.donchianLow20) /
              features.close
          : activeRegime === 'trend'
            ? ((features.atr14 ?? 0) * 2) / features.close
            : activeRegime === 'range' && features.bollingerWidth != null
              ? features.bollingerWidth / features.close
              : 0
  const threshold =
    id === 'micro-bollinger-reversion'
      ? 0.01
      : id === 'micro-donchian-breakout'
        ? 0.008
        : FAST_REPLAY_COST_GATE
  return distance >= threshold
}

export function resample1mTo15m(
  candles: readonly FastReplayCandle[],
  cutoffEpochSeconds: number,
): FastReplayCandle[] {
  const sorted = [...candles].sort((a, b) => a.timestamp - b.timestamp)
  const buckets = new Map<number, FastReplayCandle[]>()
  for (const candle of sorted) {
    if (candle.timestamp + 60 > cutoffEpochSeconds) continue
    const start = Math.floor(candle.timestamp / 900) * 900
    const bucket = buckets.get(start) ?? []
    bucket.push(candle)
    buckets.set(start, bucket)
  }
  const result: FastReplayCandle[] = []
  for (const [timestamp, rows] of buckets) {
    if (
      timestamp % 900 !== 0 ||
      timestamp + 900 > cutoffEpochSeconds ||
      rows.length !== 15
    )
      continue
    if (rows.some((row, index) => row.timestamp !== timestamp + index * 60))
      continue
    result.push({
      timestamp,
      open: rows[0]!.open,
      high: Math.max(...rows.map(({ high }) => high)),
      low: Math.min(...rows.map(({ low }) => low)),
      close: rows[14]!.close,
      volume: rows.reduce((sum, row) => sum + row.volume, 0),
    })
  }
  return result
}
export function fastReplayFeaturesAt(
  history: readonly FastReplayCandle[],
): MicroStrategyFeatures {
  const close = history.at(-1)!.close
  const closes = history.map((candle) => candle.close)
  const mean = (values: readonly number[]) =>
    values.reduce((sum, value) => sum + value, 0) / values.length
  const tail = (values: readonly number[], count: number) =>
    values.slice(-count)
  const ema = (values: readonly number[], period: number) => {
    if (values.length < period) return null
    let result = mean(values.slice(0, period))
    const alpha = 2 / (period + 1)
    for (const value of values.slice(period))
      result = alpha * value + (1 - alpha) * result
    return result
  }
  const rsi14 = rsiWilder(closes, 14)
  const bb = tail(closes, 20)
  const bollingerMid = bb.length < 20 ? null : mean(bb)
  const bollingerLower =
    bollingerMid === null
      ? null
      : bollingerMid -
        2 * Math.sqrt(mean(bb.map((value) => (value - bollingerMid) ** 2)))
  const bollingerUpper =
    bollingerMid === null
      ? null
      : bollingerMid +
        2 * Math.sqrt(mean(bb.map((value) => (value - bollingerMid) ** 2)))
  const channel = history.slice(0, -1).slice(-20)
  const donchianHigh20 =
    channel.length < 20 ? null : Math.max(...channel.map(({ high }) => high))
  const donchianLow20 =
    channel.length < 20 ? null : Math.min(...channel.map(({ low }) => low))
  const donchianMid20 =
    channel.length < 20
      ? null
      : (Math.max(...channel.map(({ high }) => high)) +
          Math.min(...channel.map(({ low }) => low))) /
        2
  const ranges = history
    .slice(1)
    .map((item, index) =>
      Math.max(
        item.high - item.low,
        Math.abs(item.high - history[index]!.close),
        Math.abs(item.low - history[index]!.close),
      ),
    )
  const atrSeries: (number | null)[] = Array(ranges.length + 1).fill(null)
  if (ranges.length >= 14) {
    let atr = mean(ranges.slice(0, 14))
    atrSeries[14] = atr
    for (let index = 14; index < ranges.length; index += 1) {
      atr = (atr * 13 + ranges[index]!) / 14
      atrSeries[index + 1] = atr
    }
  }
  const atr14 = atrSeries.at(-1) ?? null
  const priorAtrValues = atrSeries
    .slice(0, -1)
    .filter((value): value is number => value !== null)
    .slice(-20)
  const priorAtrSma20 = priorAtrValues.length < 20 ? null : mean(priorAtrValues)
  const volume = history.at(-1)!.volume
  const prior = history.slice(0, -1).map(({ volume: item }) => item)
  const atrWindow = atrSeries
    .slice(-50)
    .filter((value): value is number => value !== null)
  const atrPercentile50 =
    atr14 === null || atrWindow.length < 50
      ? null
      : (atrWindow.filter((value) => value <= atr14).length /
          atrWindow.length) *
        100
  return {
    ema9: ema(closes, 9),
    ema21: ema(closes, 21),
    sma50: closes.length < 50 ? null : mean(tail(closes, 50)),
    rsi14,
    close,
    bollingerLower,
    bollingerMid,
    bollingerUpper,
    bollingerWidth:
      bollingerUpper === null || bollingerLower === null
        ? null
        : bollingerUpper - bollingerLower,
    atr14,
    priorAtrSma20,
    donchianHigh20,
    donchianLow20,
    donchianMid20,
    volume,
    priorVolumeSma20: prior.length < 20 ? null : mean(tail(prior, 20)),
    atrPercentile50,
    ready:
      closes.length >= 50 &&
      rsi14 !== null &&
      bollingerMid !== null &&
      atr14 !== null &&
      priorAtrSma20 !== null &&
      donchianHigh20 !== null &&
      donchianLow20 !== null &&
      prior.length >= 20,
  }
}
function rsiWilder(values: readonly number[], period: number): number | null {
  if (values.length < period + 1) return null
  let gain = 0
  let loss = 0
  for (let index = 1; index <= period; index += 1) {
    const delta = values[index]! - values[index - 1]!
    gain += Math.max(delta, 0)
    loss += Math.max(-delta, 0)
  }
  gain /= period
  loss /= period
  for (let index = period + 1; index < values.length; index += 1) {
    const delta = values[index]! - values[index - 1]!
    gain = (gain * (period - 1) + Math.max(delta, 0)) / period
    loss = (loss * (period - 1) + Math.max(-delta, 0)) / period
  }
  if (loss === 0) return gain === 0 ? 50 : 100
  if (gain === 0) return 0
  return 100 - 100 / (1 + gain / loss)
}
function validateCandles(candles: readonly FastReplayCandle[]): void {
  for (const candle of candles)
    if (
      !Number.isSafeInteger(candle.timestamp) ||
      candle.timestamp < 0 ||
      [candle.open, candle.high, candle.low, candle.close, candle.volume].some(
        (value) => !Number.isFinite(value),
      ) ||
      Math.min(candle.open, candle.high, candle.low, candle.close) <= 0 ||
      candle.volume < 0 ||
      candle.high < Math.max(candle.open, candle.close) ||
      candle.low > Math.min(candle.open, candle.close)
    )
      throw new Error('OHLC dataset contains an invalid candle.')
}
