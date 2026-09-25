import type { MarketStore, PaperOrder } from '../market-data/market-store.ts'
import type { MicroRegime } from '../simulations/micro-strategy.ts'
import {
  STRATEGY_ANALYTICS_CANDIDATES,
  type StrategySummaryMetric,
} from './types.ts'

const SLIPPAGE_RATE = 0.0005

export function getStrategiesAnalyticsSummary(
  store: Pick<MarketStore, 'paperOrderSignalAggregates' | 'listPaperOrders'>,
): StrategySummaryMetric[] {
  const aggregates = new Map(
    store
      .paperOrderSignalAggregates()
      .map((aggregate) => [aggregate.strategy_id, aggregate]),
  )
  return summarizeStrategies(store.listPaperOrders()).map((metric) => {
    const aggregate = aggregates.get(metric.strategy_id)
    if (aggregate === undefined) return metric
    const netPnlEur =
      metric.closed_trades === aggregate.executed_sells
        ? aggregate.net_pnl_eur
        : metric.net_pnl_eur
    return {
      ...metric,
      total_signals: aggregate.total_signals,
      gate_rejections: aggregate.gate_rejections,
      executed_buys: aggregate.executed_buys,
      executed_sells: aggregate.executed_sells,
      approval_rate_pct:
        aggregate.total_signals === 0
          ? 0
          : (aggregate.executed_buys / aggregate.total_signals) * 100,
      total_fees_eur: aggregate.total_fees_eur,
      net_pnl_eur: netPnlEur,
      net_pnl_pct: (netPnlEur / metric.assigned_capital_eur) * 100,
      avg_target_pct: aggregate.avg_target_pct,
    }
  })
}

export function summarizeStrategies(
  orders: readonly PaperOrder[],
): StrategySummaryMetric[] {
  return STRATEGY_ANALYTICS_CANDIDATES.map(({ id, name }) => {
    const rows = orders
      .filter((row) => row.strategyId === id)
      .sort((a, b) => a.signalTimestamp - b.signalTimestamp || a.id - b.id)
    const buys = rows.filter((row) => row.action === 'BUY')
    const executedBuys = buys.filter(
      (row) => row.gatePassed && row.executionTimestamp !== null,
    )
    const executedSells = rows.filter(
      (row) => row.action === 'SELL' && row.executionTimestamp !== null,
    )
    const rejections = buys.filter((row) => !row.gatePassed).length
    const closed: {
      pnl: number
      bars: number
      fees: number
      slippage: number
    }[] = []
    let open: PaperOrder | null = null
    let slippage = 0
    let fees = 0
    let entryFee = 0
    let entrySlippage = 0
    for (const row of [...rows].sort(
      (a, b) =>
        (a.executionTimestamp ?? a.signalTimestamp) -
          (b.executionTimestamp ?? b.signalTimestamp) || a.id - b.id,
    )) {
      if (row.executionTimestamp === null || !row.gatePassed) continue
      fees += row.feeEur
      if (row.action === 'BUY') {
        const buySlippage = row.amountEur * SLIPPAGE_RATE
        slippage += buySlippage
        if (open === null) {
          open = row
          entryFee = row.feeEur
          entrySlippage = buySlippage
        }
      } else {
        if (open === null) continue
        const sellSlippage =
          (open.amountEur + (row.pnlEur ?? 0)) * SLIPPAGE_RATE
        slippage += sellSlippage
        closed.push({
          pnl: row.pnlEur ?? 0,
          bars: (row.executionTimestamp - open.executionTimestamp!) / 900,
          fees: entryFee + row.feeEur,
          slippage: entrySlippage + sellSlippage,
        })
        open = null
      }
    }
    const gains = closed.reduce((sum, trade) => sum + Math.max(0, trade.pnl), 0)
    const losses = closed.reduce(
      (sum, trade) => sum + Math.max(0, -trade.pnl),
      0,
    )
    const net = closed.reduce((sum, trade) => sum + trade.pnl, 0)
    const gross = closed.reduce(
      (sum, trade) => sum + trade.pnl + trade.fees + trade.slippage,
      0,
    )
    return {
      strategy_id: id,
      name,
      total_signals: buys.length,
      gate_rejections: rejections,
      approval_rate_pct:
        buys.length === 0 ? 0 : (executedBuys.length / buys.length) * 100,
      executed_buys: executedBuys.length,
      executed_sells: executedSells.length,
      open_positions_count: open === null ? 0 : 1,
      assigned_capital_eur: 30,
      current_exposure: open === null ? 'flat' : 'long',
      closed_trades: closed.length,
      wins: closed.filter(({ pnl }) => pnl > 0).length,
      win_rate_pct:
        closed.length === 0
          ? 0
          : (closed.filter(({ pnl }) => pnl > 0).length / closed.length) * 100,
      profit_factor: losses === 0 ? null : gains / losses,
      avg_holding_bars_15m:
        closed.length === 0
          ? 0
          : closed.reduce((sum, trade) => sum + trade.bars, 0) / closed.length,
      gross_pnl_eur: gross,
      avg_target_pct:
        buys.length === 0
          ? 0
          : buys.reduce((sum, row) => sum + row.targetPct, 0) / buys.length,
      total_fees_eur: fees,
      total_slippage_eur: slippage,
      net_pnl_eur: net,
      net_pnl_pct: (net / 30) * 100,
      toll_ratio: gross === 0 ? null : (fees + slippage) / Math.abs(gross),
      brier_score: null,
    }
  })
}

export function buildStrategyPositions(
  orders: readonly PaperOrder[],
  currentPrice: number | null,
  features: ReturnType<
    typeof import('../simulations/fast-replay-engine.ts').fastReplayFeaturesAt
  > | null,
  asOfTimestamp: number | null = null,
  regimeAdapterRegime: MicroRegime = null,
): import('./types.ts').PaperTradePosition[] {
  const result: import('./types.ts').PaperTradePosition[] = []
  for (const { id } of STRATEGY_ANALYTICS_CANDIDATES) {
    let open: PaperOrder | null = null
    for (const row of [...orders]
      .filter((order) => order.strategyId === id)
      .sort(
        (a, b) =>
          (a.executionTimestamp ?? a.signalTimestamp) -
            (b.executionTimestamp ?? b.signalTimestamp) || a.id - b.id,
      )) {
      if (!row.gatePassed || row.executionTimestamp === null) continue
      if (row.action === 'BUY') {
        if (open === null) open = row
        continue
      }
      if (open === null) continue
      const entryTimestamp = open.executionTimestamp
      if (entryTimestamp === null) continue
      const slippageBuy = open.amountEur * SLIPPAGE_RATE
      const slippageSell = (open.amountEur + (row.pnlEur ?? 0)) * SLIPPAGE_RATE
      result.push({
        id: open.id,
        strategy_id: id,
        status: 'CLOSED',
        entry_time: new Date(entryTimestamp * 1000).toISOString(),
        exit_time: new Date(row.executionTimestamp * 1000).toISOString(),
        entry_price: open.price,
        exit_price: row.price,
        amount_eur: open.amountEur,
        fee_eur: open.feeEur + row.feeEur,
        total_slippage_eur: slippageBuy + slippageSell,
        net_pnl_eur: row.pnlEur ?? 0,
        gross_pnl_eur:
          (row.pnlEur ?? 0) +
          open.feeEur +
          row.feeEur +
          slippageBuy +
          slippageSell,
        holding_bars_15m: (row.executionTimestamp - entryTimestamp) / 900,
        current_price: null,
        unrealized_net_pnl_eur: null,
        exit_distance_pct: null,
        exit_distance_label: 'Sin datos',
      })
      open = null
    }
    if (open === null) continue
    const entryTimestamp = open.executionTimestamp
    if (entryTimestamp === null) continue
    const exitReference = exitReferenceFor(
      id,
      open,
      features,
      currentPrice,
      asOfTimestamp,
      regimeAdapterRegime,
    )
    const quantity = open.amountEur / open.price
    const unrealized =
      currentPrice === null
        ? null
        : quantity * currentPrice * (1 - 0.001 - SLIPPAGE_RATE) -
          (open.amountEur + open.feeEur)
    result.push({
      id: open.id,
      strategy_id: id,
      status: 'OPEN',
      entry_time: new Date(entryTimestamp * 1000).toISOString(),
      exit_time: null,
      entry_price: open.price,
      exit_price: null,
      amount_eur: open.amountEur,
      fee_eur: open.feeEur,
      total_slippage_eur: open.amountEur * SLIPPAGE_RATE,
      net_pnl_eur: null,
      gross_pnl_eur: null,
      holding_bars_15m:
        asOfTimestamp === null
          ? 0
          : Math.max(0, (asOfTimestamp - entryTimestamp) / 900),
      current_price: currentPrice,
      unrealized_net_pnl_eur: unrealized,
      exit_distance_pct:
        currentPrice === null || exitReference === null
          ? null
          : Math.abs((exitReference - currentPrice) / currentPrice) * 100,
      exit_distance_label:
        exitReference === null
          ? 'Sin datos'
          : exitReference === currentPrice
            ? 'Salida inmediata'
            : 'Distancia al nivel de salida',
    })
  }
  return result.sort(
    (a, b) => b.entry_time.localeCompare(a.entry_time) || b.id - a.id,
  )
}

function exitReferenceFor(
  id: string,
  entry: PaperOrder,
  features: ReturnType<
    typeof import('../simulations/fast-replay-engine.ts').fastReplayFeaturesAt
  > | null,
  currentPrice: number | null,
  asOfTimestamp: number | null,
  regimeAdapterRegime: MicroRegime,
): number | null {
  if (features?.ready !== true) return null
  if (id === 'micro-trend-pullback') {
    if (
      features.ema21 === null ||
      features.rsi14 === null ||
      currentPrice === null
    )
      return null
    return features.rsi14 > 68 || currentPrice < features.ema21
      ? currentPrice
      : features.ema21
  }
  if (id === 'micro-bollinger-reversion') {
    if (
      features.bollingerMid === null ||
      features.rsi14 === null ||
      currentPrice === null
    )
      return null
    return features.rsi14 > 55 || currentPrice >= features.bollingerMid
      ? currentPrice
      : features.bollingerMid
  }
  if (id === 'micro-donchian-breakout') {
    if (currentPrice === null) return null
    const levels = [entry.price * 1.018, entry.price * 0.991]
    if (features.donchianMid20 !== null) levels.push(features.donchianMid20)
    if (
      asOfTimestamp !== null &&
      (asOfTimestamp - entry.executionTimestamp!) / 900 >= 8
    )
      levels.push(entry.price * 1.005)
    return levels.reduce((nearest, level) =>
      Math.abs(level - currentPrice) < Math.abs(nearest - currentPrice)
        ? level
        : nearest,
    )
  }
  if (regimeAdapterRegime === 'trend') {
    if (
      features.ema21 === null ||
      features.rsi14 === null ||
      currentPrice === null
    )
      return null
    return features.rsi14 > 68 || currentPrice < features.ema21
      ? currentPrice
      : features.ema21
  }
  if (regimeAdapterRegime === 'range') {
    if (
      features.bollingerMid === null ||
      features.rsi14 === null ||
      currentPrice === null
    )
      return null
    return features.rsi14 > 55 || currentPrice >= features.bollingerMid
      ? currentPrice
      : features.bollingerMid
  }
  return null
}
