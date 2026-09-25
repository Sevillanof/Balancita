export type StrategyAnalyticsId =
  | 'micro-trend-pullback'
  | 'micro-bollinger-reversion'
  | 'micro-donchian-breakout'
  | 'micro-regime-adapter'

export interface StrategySummaryMetric {
  readonly strategy_id: StrategyAnalyticsId
  readonly name: string
  readonly total_signals: number
  readonly gate_rejections: number
  readonly approval_rate_pct: number
  readonly executed_buys: number
  readonly executed_sells: number
  readonly open_positions_count: number
  readonly assigned_capital_eur: 30
  readonly current_exposure: 'flat' | 'long'
  readonly closed_trades: number
  readonly wins: number
  readonly win_rate_pct: number
  readonly profit_factor: number | null
  readonly avg_holding_bars_15m: number
  readonly gross_pnl_eur: number
  readonly avg_target_pct: number
  readonly total_fees_eur: number
  readonly total_slippage_eur: number
  readonly net_pnl_eur: number
  readonly net_pnl_pct: number
  readonly toll_ratio: number | null
  readonly brier_score: null
}

export interface PaperTradePosition {
  readonly id: number
  readonly strategy_id: StrategyAnalyticsId
  readonly status: 'OPEN' | 'CLOSED'
  readonly entry_time: string
  readonly exit_time: string | null
  readonly entry_price: number
  readonly exit_price: number | null
  readonly amount_eur: number
  readonly holding_bars_15m: number
  readonly gross_pnl_eur: number | null
  readonly fee_eur: number
  readonly total_slippage_eur: number
  readonly net_pnl_eur: number | null
  readonly current_price: number | null
  readonly unrealized_net_pnl_eur: number | null
  readonly exit_distance_pct: number | null
  readonly exit_distance_label: string
}
