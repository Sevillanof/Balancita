import { createHash, randomUUID } from 'node:crypto'
import { candidateForId } from './candidate-manifest.ts'
import type { DecisionCondition } from '../../domain/contracts.ts'
import type {
  FastReplayCandle,
  FastReplayEntryGateDiagnostic,
  FastReplayStrategyId,
} from './fast-replay-engine.ts'
import {
  FAST_REPLAY_FEE,
  FAST_REPLAY_SLIPPAGE,
  FAST_REPLAY_STRATEGIES,
  fastReplayCanEnter,
  fastReplayFeaturesAt,
  fastReplayStrategyFor,
  resample1mTo15m,
} from './fast-replay-engine.ts'
import {
  KRAKEN_PRO_SPOT_TIER1_TAKER_FEE_SCENARIO,
  SIMULATED_COSTS_CAVEAT,
} from './fee-scenario.ts'
import {
  evaluateC27ExitWithMacroContext,
  evaluateMicroTarget,
  initialMicroState,
  macroContextWhenReady,
  type MicroRegime,
  type MicroStrategyDiagnostic,
  type MicroStrategyState,
} from './micro-strategy.ts'
import type { MarketStore, PaperOrder } from '../market-data/market-store.ts'

const INITIAL_CASH_EUR = 10_000
const TICKET_EUR = 30
const MACRO_HISTORY_CANDLES = 1_200
const REQUIRED_NATIVE_CANDLES = 50

export function paperForwardSellAccounting(
  quantityBtc: number,
  priceEur: number,
  persistedEntryCostEur: number,
): { feeEur: number; pnlEur: number } {
  const gross = quantityBtc * priceEur
  const feeEur = gross * FAST_REPLAY_FEE
  return { feeEur, pnlEur: gross - feeEur - persistedEntryCostEur }
}

interface PendingExecution {
  readonly action: 'BUY' | 'SELL'
  readonly signalTimestamp: number
  readonly targetPct: number
  readonly state: MicroStrategyState
}

export interface PaperForwardStatus {
  fee_scenario: typeof KRAKEN_PRO_SPOT_TIER1_TAKER_FEE_SCENARIO
  cost_caveat: typeof SIMULATED_COSTS_CAVEAT
  enabled: boolean
  running: boolean
  stream_state: string
  last_received_event_time: number | null
  last_received_at: number | null
  last_processed_event_time: number | null
  candles_ready: boolean
  account: {
    balance_eur: number
    btc_balance: number
    total_equity_eur: number
  }
  active_positions: readonly {
    strategy_id: string
    entry_price: number
    amount_eur: number
    open_time: string
  }[]
  execution_summary: {
    total_signals: number
    gate_rejections: number
    executed_trades: number
    closed_pnl_eur: number
  }
}

export class PaperForwardService {
  private readonly options: { store: MarketStore; clock?: () => number }
  private candles: FastReplayCandle[] = []
  private states = new Map<FastReplayStrategyId, MicroStrategyState>()
  private pending = new Map<FastReplayStrategyId, PendingExecution>()
  private lastProcessed: number | null = null
  private lastReceived: number | null = null
  private lastReceivedAt: number | null = null
  private running = false
  private streamState = 'disabled'
  private lastEvaluatedBucketEnd: number | null = null
  private readonly sessionId = randomUUID()

  constructor(options: { store: MarketStore; clock?: () => number }) {
    this.options = options
    for (const id of FAST_REPLAY_STRATEGIES)
      this.states.set(id, initialMicroState())
    this.reconstruct()
  }

  setStreamState(state: string): void {
    this.streamState = state
  }
  setRunning(running: boolean): void {
    this.running = running
  }
  recordReceivedEvent(eventTimestamp: number, receivedTimestamp: number): void {
    this.lastReceived = eventTimestamp
    this.lastReceivedAt = receivedTimestamp
  }

  lastProcessedCandleTimestamp(): number | null {
    return this.lastProcessed === null
      ? null
      : Math.floor(this.lastProcessed / 1000)
  }

  storeLatestOhlcTimestamp(): number | null {
    return this.options.store.latestOhlcTimestamp()
  }

  getCurrentRegime(id: FastReplayStrategyId): MicroRegime {
    return this.states.get(id)?.regime ?? null
  }

  processClosedCandle(candle: FastReplayCandle, nextOpen?: number): void {
    if (
      this.lastProcessed !== null &&
      candle.timestamp * 1000 <= this.lastProcessed
    )
      return
    this.lastProcessed = candle.timestamp * 1000
    this.options.store.insertOhlcCandles([
      { ...candle, source: 'kraken_ws_ohlc' },
    ])
    const bucketStart = Math.floor(candle.timestamp / 900) * 900
    for (const id of FAST_REPLAY_STRATEGIES) {
      const pending = this.pending.get(id)
      if (pending !== undefined && candle.timestamp > pending.signalTimestamp)
        this.pending.delete(id)
      else if (
        candle.timestamp === bucketStart &&
        pending?.signalTimestamp === candle.timestamp
      ) {
        this.executePending(id, pending, candle.open)
        this.pending.delete(id)
      }
    }
    const persistedHistory = [
      ...this.options.store.latestContinuousOhlcCandles(
        MACRO_HISTORY_CANDLES,
        candle.timestamp * 1000,
      ),
    ]
    this.candles = persistedHistory
    const macroCandles = resample1mTo15m(
      persistedHistory,
      candle.timestamp + 60,
    )
    const completed = macroCandles.at(-1)
    const bucketEnd = bucketStart + 900
    if (
      completed === undefined ||
      completed.timestamp + 900 !== bucketEnd ||
      this.lastEvaluatedBucketEnd === bucketEnd
    )
      return
    this.lastEvaluatedBucketEnd = bucketEnd
    if (macroCandles.length < REQUIRED_NATIVE_CANDLES) return
    const features = fastReplayFeaturesAt(macroCandles)
    const macroFeatures = features
    for (const id of FAST_REPLAY_STRATEGIES) {
      const prior = this.states.get(id) ?? initialMicroState()
      let strategyDiagnostic: MicroStrategyDiagnostic | undefined
      const decision = evaluateMicroTarget(
        fastReplayStrategyFor(id),
        features,
        prior,
        macroContextWhenReady(macroFeatures),
        (diagnostic) => {
          strategyDiagnostic = diagnostic
        },
      )
      const position = this.position(id)
      let c27Diagnostic: MicroStrategyDiagnostic | undefined
      const target =
        id === 'micro-donchian-breakout' && position !== null
          ? evaluateC27ExitWithMacroContext(
              {
                entryPrice: position.entryPrice,
                close: completed.close,
                macroContext: macroContextWhenReady(macroFeatures),
                barsHeld: Math.floor((bucketEnd - position.openTime) / 900),
              },
              (diagnostic) => {
                c27Diagnostic = diagnostic
              },
            ) === 'hold'
            ? 'long'
            : 'flat'
          : decision.target
      let reasonCode = strategyDiagnostic?.reasonCode ?? null
      let conditions = [...(strategyDiagnostic?.conditions ?? [])]
      if (c27Diagnostic !== undefined && !decision.abstained) {
        reasonCode = c27Diagnostic.reasonCode
        conditions = [...c27Diagnostic.conditions]
      }
      if (position !== null && decision.abstained) {
        this.recordDecision(
          id,
          bucketEnd,
          'flat',
          'abstained',
          reasonCode,
          conditions,
        )
        this.states.set(id, { ...prior, exposure: 'long' })
        continue
      }
      if (position === null && decision.target === 'long') {
        const distance =
          macroFeatures?.ready !== true
            ? 0
            : candidateTargetPct(
                id,
                features,
                decision.state.regime,
                macroFeatures,
              )
        let gateDiagnostic: FastReplayEntryGateDiagnostic | undefined
        const passed = fastReplayCanEnter(
          id,
          features,
          decision.state.regime,
          macroFeatures,
          (diagnostic) => {
            gateDiagnostic = diagnostic
          },
        )
        const gateConditions: DecisionCondition[] =
          gateDiagnostic === undefined
            ? []
            : gateDiagnostic.distance === null ||
                gateDiagnostic.threshold === null
              ? [
                  {
                    code: 'entry_gate_features_ready',
                    value: false,
                    operator: 'is',
                    threshold: true,
                    passed: false,
                  },
                ]
              : [
                  {
                    code: 'entry_gate_distance',
                    value: gateDiagnostic.distance,
                    operator: '>=',
                    threshold: gateDiagnostic.threshold,
                    passed: gateDiagnostic.passed,
                  },
                ]
        if (!passed) {
          this.recordDecision(
            id,
            bucketEnd,
            'long',
            'gate-rejected',
            gateDiagnostic?.reasonCode ?? 'entry_gate_rejected',
            [...conditions, ...gateConditions],
          )
          const inserted = this.options.store.insertPaperOrder({
            strategyId: id,
            signalTimestamp: bucketEnd,
            action: 'BUY',
            gatePassed: false,
            price: candle.close,
            executionTimestamp: null,
            amountEur: TICKET_EUR,
            feeEur: 0,
            pnlEur: null,
            targetPct: distance,
          })
          if (inserted)
            this.states.set(id, { ...decision.state, exposure: 'flat' })
          continue
        }
        this.recordDecision(
          id,
          bucketEnd,
          'long',
          'pending',
          gateDiagnostic?.reasonCode ?? reasonCode,
          [...conditions, ...gateConditions],
        )
        this.pending.set(id, {
          action: 'BUY',
          signalTimestamp: bucketEnd,
          targetPct: distance,
          state: decision.state,
        })
        this.states.set(id, { ...decision.state, exposure: 'flat' })
      } else if (position !== null && target === 'flat') {
        this.recordDecision(
          id,
          bucketEnd,
          'flat',
          'pending',
          reasonCode,
          conditions,
        )
        this.pending.set(id, {
          action: 'SELL',
          signalTimestamp: bucketEnd,
          targetPct: 0,
          state: decision.state,
        })
      } else {
        this.recordDecision(
          id,
          bucketEnd,
          target,
          decision.abstained ? 'abstained' : 'hold',
          reasonCode,
          conditions,
        )
        this.states.set(id, decision.state)
      }
    }
    void nextOpen
  }

  status(enabled = true): PaperForwardStatus {
    const orders = this.options.store.listPaperOrders()
    const positions = FAST_REPLAY_STRATEGIES.flatMap((id) => {
      const position = this.position(id)
      return position === null
        ? []
        : [
            {
              strategy_id: id,
              entry_price: position.entryPrice,
              amount_eur: TICKET_EUR,
              open_time: new Date(position.openTime * 1000).toISOString(),
              quantityBtc: position.quantityBtc,
            },
          ]
    })
    const balance = accountBalance(orders)
    const btcBalance = positions.reduce(
      (sum, item) => sum + item.quantityBtc,
      0,
    )
    const latest =
      this.candles.at(-1)?.close ??
      this.options.store.listOhlcCandles(0, Number.MAX_SAFE_INTEGER).at(-1)
        ?.close ??
      0
    return {
      fee_scenario: KRAKEN_PRO_SPOT_TIER1_TAKER_FEE_SCENARIO,
      cost_caveat: SIMULATED_COSTS_CAVEAT,
      enabled,
      running: this.running,
      stream_state: this.streamState,
      last_received_event_time: this.lastReceived,
      last_received_at: this.lastReceivedAt,
      last_processed_event_time:
        this.lastProcessed === null ? null : this.lastProcessed + 60_000,
      candles_ready:
        resample1mTo15m(this.candles, Number.MAX_SAFE_INTEGER).length >=
        REQUIRED_NATIVE_CANDLES,
      account: {
        balance_eur: balance,
        btc_balance: btcBalance,
        total_equity_eur: balance + btcBalance * latest,
      },
      active_positions: positions.map(
        ({ strategy_id, entry_price, amount_eur, open_time }) => ({
          strategy_id,
          entry_price,
          amount_eur,
          open_time,
        }),
      ),
      execution_summary: {
        total_signals: orders.length,
        gate_rejections: orders.filter(
          (order) => order.action === 'BUY' && !order.gatePassed,
        ).length,
        executed_trades: orders.filter(
          (order) => order.executionTimestamp !== null,
        ).length,
        closed_pnl_eur: orders.reduce(
          (sum, order) => sum + (order.pnlEur ?? 0),
          0,
        ),
      },
    }
  }

  private reconstruct(): void {
    const orders = this.options.store.listPaperOrders()
    for (const id of FAST_REPLAY_STRATEGIES) {
      const candidate = orders.filter(
        (order) => order.strategyId === id && order.executionTimestamp !== null,
      )
      const last = candidate.at(-1)
      this.states.set(id, {
        exposure: last?.action === 'BUY' ? 'long' : 'flat',
        regime: null,
      })
    }
    const latestTimestamp = this.options.store.latestOhlcTimestamp()
    this.candles =
      latestTimestamp === null
        ? []
        : [
            ...this.options.store.latestContinuousOhlcCandles(
              MACRO_HISTORY_CANDLES,
              latestTimestamp * 1000,
            ),
          ]
    const completed = resample1mTo15m(this.candles, Number.MAX_SAFE_INTEGER).at(
      -1,
    )
    this.lastEvaluatedBucketEnd =
      completed === undefined ? null : completed.timestamp + 900
  }

  private position(id: string): {
    quantityBtc: number
    entryPrice: number
    entryCost: number
    openTime: number
  } | null {
    let current: {
      quantityBtc: number
      entryPrice: number
      entryCost: number
      openTime: number
    } | null = null
    for (const row of this.options.store.listPaperOrders()) {
      if (row.strategyId !== id || row.executionTimestamp === null) continue
      if (row.action === 'BUY')
        current = {
          quantityBtc: row.amountEur / row.price,
          entryPrice: row.price,
          entryCost: row.amountEur + row.feeEur,
          openTime: row.executionTimestamp,
        }
      else current = null
    }
    return current
  }

  private executePending(
    id: FastReplayStrategyId,
    pending: PendingExecution,
    barOpen: number,
  ): void {
    const position = this.position(id)
    if (pending.action === 'BUY') {
      if (position !== null) return
      const price = barOpen * (1 + FAST_REPLAY_SLIPPAGE)
      const inserted = this.options.store.insertPaperOrder({
        strategyId: id,
        signalTimestamp: pending.signalTimestamp,
        action: 'BUY',
        gatePassed: true,
        price,
        executionTimestamp: pending.signalTimestamp,
        amountEur: TICKET_EUR,
        feeEur: TICKET_EUR * FAST_REPLAY_FEE,
        pnlEur: null,
        targetPct: pending.targetPct,
      })
      if (inserted) this.states.set(id, { ...pending.state, exposure: 'long' })
      return
    }
    if (position === null) return
    const price = barOpen * (1 - FAST_REPLAY_SLIPPAGE)
    const { feeEur, pnlEur } = paperForwardSellAccounting(
      position.quantityBtc,
      price,
      position.entryCost,
    )
    const inserted = this.options.store.insertPaperOrder({
      strategyId: id,
      signalTimestamp: pending.signalTimestamp,
      action: 'SELL',
      gatePassed: true,
      price,
      executionTimestamp: pending.signalTimestamp,
      amountEur: TICKET_EUR,
      feeEur,
      pnlEur,
      targetPct: 0,
    })
    if (inserted) this.states.set(id, { ...pending.state, exposure: 'flat' })
  }

  private recordDecision(
    strategyId: FastReplayStrategyId,
    timestampSeconds: number,
    direction: 'flat' | 'long',
    outcome: 'abstained' | 'gate-rejected' | 'pending' | 'hold',
    reasonCode: string | null,
    conditions: readonly DecisionCondition[],
  ): void {
    const strategyVersion = candidateForId(strategyId).ruleVersion
    const eventTime = timestampSeconds * 1000
    const id = createHash('sha256')
      .update(
        JSON.stringify([
          'paper-forward',
          'BTC-EUR',
          strategyId,
          strategyVersion,
          eventTime,
        ]),
      )
      .digest('hex')
    this.options.store.insertPaperDecision({
      id,
      instrumentId: 'BTC-EUR',
      eventTime,
      receivedAt: (this.options.clock ?? Date.now)(),
      strategyId,
      strategyVersion,
      direction,
      outcome,
      reason: null,
      reasonCode,
      sessionId: this.sessionId,
      conditions,
    })
  }
}

function accountBalance(orders: readonly PaperOrder[]): number {
  return (
    INITIAL_CASH_EUR +
    orders.reduce((cash, row) => {
      if (row.executionTimestamp === null) return cash
      return row.action === 'BUY'
        ? cash - row.amountEur - row.feeEur
        : cash + quantityForSell(orders, row) * row.price - row.feeEur
    }, 0)
  )
}

function quantityForSell(
  orders: readonly PaperOrder[],
  sell: PaperOrder,
): number {
  let quantity = 0
  for (const row of orders) {
    if (row.strategyId !== sell.strategyId) continue
    if (row.id === sell.id) break
    if (row.executionTimestamp === null) continue
    if (row.action === 'BUY') quantity = row.amountEur / row.price
    else quantity = 0
  }
  return quantity
}

export function candidateTargetPct(
  id: FastReplayStrategyId,
  features: ReturnType<typeof fastReplayFeaturesAt>,
  regime: 'trend' | 'range' | null,
  macro: ReturnType<typeof fastReplayFeaturesAt>,
): number {
  const distance =
    id === 'micro-trend-pullback'
      ? ((macro.atr14 ?? 0) * 2) / features.close
      : id === 'micro-bollinger-reversion'
        ? macro.bollingerWidth == null
          ? 0
          : macro.bollingerWidth / features.close
        : id === 'micro-donchian-breakout'
          ? macro.donchianHigh20 === null || macro.donchianLow20 == null
            ? 0
            : (macro.donchianHigh20 - macro.donchianLow20) / features.close
          : regime === 'trend'
            ? ((macro.atr14 ?? 0) * 2) / features.close
            : regime === 'range' &&
                macro.bollingerMid !== null &&
                macro.bollingerLower !== null
              ? (2 * (macro.bollingerMid - macro.bollingerLower)) /
                features.close
              : 0
  return Math.max(0, distance)
}
