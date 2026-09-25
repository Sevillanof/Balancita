import type { StrategySummaryMetric } from './types.ts'

const euro = new Intl.NumberFormat('es-ES', {
  style: 'currency',
  currency: 'EUR',
})
const percent = (value: number | null) =>
  value === null ? '—' : `${value.toFixed(2)}%`

export default function StrategyCards({
  strategies,
  fastReplayBrier,
}: {
  strategies: readonly StrategySummaryMetric[]
  fastReplayBrier: Readonly<Record<string, number | null>>
}) {
  return (
    <div className="strategy-analytics__cards">
      {strategies.map((item) => (
        <article className="strategy-analytics__card" key={item.strategy_id}>
          <header>
            <h3>{item.name}</h3>
            <span className="strategy-analytics__badge">
              {item.current_exposure === 'long' ? 'LONG' : 'FLAT'} ·{' '}
              {euro.format(item.assigned_capital_eur)}
            </span>
          </header>
          <p>
            Señales {item.total_signals} → rechazos {item.gate_rejections} →
            compras {item.executed_buys} · Posiciones abiertas{' '}
            {item.open_positions_count}
          </p>
          <p>
            Aprobación {percent(item.approval_rate_pct)} · Neto{' '}
            {euro.format(item.net_pnl_eur)} ({percent(item.net_pnl_pct)})
          </p>
          <p>
            Bruto {euro.format(item.gross_pnl_eur)} · Comisiones{' '}
            {euro.format(item.total_fees_eur)} · Deslizamiento{' '}
            {euro.format(item.total_slippage_eur)}
          </p>
          <p>
            Peaje / bruto{' '}
            {item.toll_ratio === null ? '—' : percent(item.toll_ratio * 100)} ·{' '}
            Acierto {percent(item.win_rate_pct)} · Factor{' '}
            {item.profit_factor === null ? '—' : item.profit_factor.toFixed(2)}{' '}
            · Tenencia {item.avg_holding_bars_15m.toFixed(1)} velas
          </p>
          <p>Objetivo medio: {percent(item.avg_target_pct * 100)}</p>
          <p>
            Brier en vivo: N/A · Brier Fast Replay{' '}
            {fastReplayBrier[item.strategy_id] == null
              ? 'Sin muestras'
              : fastReplayBrier[item.strategy_id]!.toFixed(4)}{' '}
            vs baseline uniforme 0.6667
          </p>
        </article>
      ))}
    </div>
  )
}
