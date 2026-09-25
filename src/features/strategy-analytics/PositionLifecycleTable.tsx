import type { PaperTradePosition } from './types.ts'

const money = (value: number | null) =>
  value === null
    ? '—'
    : new Intl.NumberFormat('es-ES', {
        style: 'currency',
        currency: 'EUR',
      }).format(value)
const percent = (value: number) =>
  `${new Intl.NumberFormat('es-ES', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)}%`
const date = (value: string | null) =>
  value === null
    ? '—'
    : `${new Intl.DateTimeFormat('es-ES', {
        timeZone: 'UTC',
        dateStyle: 'short',
        timeStyle: 'medium',
      }).format(new Date(value))} UTC`

export default function PositionLifecycleTable({
  positions,
  status,
}: {
  positions: readonly PaperTradePosition[]
  status: 'open' | 'closed'
}) {
  if (positions.length === 0)
    return (
      <p role="status">
        {status === 'open'
          ? 'Sin posiciones abiertas.'
          : 'No hay operaciones cerradas.'}
      </p>
    )

  return status === 'closed' ? (
    <div className="table-scroll">
      <table className="data-table">
        <caption>Historial de operaciones cerradas</caption>
        <thead>
          <tr>
            <th>Estrategia</th>
            <th>Entrada (UTC)</th>
            <th>Salida (UTC)</th>
            <th>Duración</th>
            <th>Precio entrada</th>
            <th>Precio salida</th>
            <th>Ticket</th>
            <th>Fricción total</th>
            <th>PnL bruto</th>
            <th>PnL neto</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((item) => (
            <tr key={item.id}>
              <th scope="row">{item.strategy_id}</th>
              <td>{date(item.entry_time)}</td>
              <td>{date(item.exit_time)}</td>
              <td>{item.holding_bars_15m} velas de 15 min</td>
              <td>{money(item.entry_price)}</td>
              <td>{money(item.exit_price)}</td>
              <td>{money(item.amount_eur)}</td>
              <td>{money(item.fee_eur + item.total_slippage_eur)}</td>
              <td>{money(item.gross_pnl_eur)}</td>
              <td>{money(item.net_pnl_eur)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <div className="table-scroll">
      <table className="data-table">
        <caption>Posiciones abiertas</caption>
        <thead>
          <tr>
            <th>Estrategia</th>
            <th>Entrada (UTC)</th>
            <th>Duración</th>
            <th>Precio entrada</th>
            <th>Precio actual</th>
            <th>Ticket</th>
            <th>PnL flotante neto</th>
            <th>Distancia a salida</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((item) => (
            <tr key={item.id}>
              <th scope="row">{item.strategy_id}</th>
              <td>{date(item.entry_time)}</td>
              <td>{item.holding_bars_15m} velas de 15 min</td>
              <td>{money(item.entry_price)}</td>
              <td>{money(item.current_price)}</td>
              <td>{money(item.amount_eur)}</td>
              <td>{money(item.unrealized_net_pnl_eur)}</td>
              <td>
                {item.exit_distance_label === 'Salida inmediata'
                  ? `Salida inmediata (${percent(0)})`
                  : item.exit_distance_pct === null
                    ? item.exit_distance_label
                    : percent(item.exit_distance_pct)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
