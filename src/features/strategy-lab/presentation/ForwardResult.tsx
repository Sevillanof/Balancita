import { StatusPill } from '../../../shared/mission-control/index.ts'
import { count, netBpPerOp, netUsd } from '../domain/strategy-format.ts'
import { agoText, stateLine } from '../domain/forward-text.ts'
import type {
  ForwardSide,
  InventoryStrategy,
} from '../infrastructure/strategy-api.ts'

function Side({
  title,
  side,
  testid,
}: {
  title: string
  side: ForwardSide
  testid: string
}) {
  const net = netUsd(side.net_usd)
  const bp = netBpPerOp(side.mean_net_bp)
  return (
    <div data-testid={testid}>
      <b>{title}</b>: {count(side.closed)} cerradas
      {side.closed > 0 && net && (
        <>
          {' '}
          ·{' '}
          <span className={side.net_usd >= 0 ? 'is-up' : 'is-down'}>
            {net}
          </span>{' '}
          netos{bp ? ` (${bp})` : ''}
        </>
      )}
      {side.closed > 0 && !side.net_is_definitive && (
        <small>
          Funding incompleto en {side.funding_incomplete}: el neto aún puede
          cambiar.
        </small>
      )}
      <div data-testid={`${testid}-open`}>
        Abiertas: {side.open.count}
        {side.open.positions.map((p) => (
          <small key={p.product_id}>
            {p.product_id} {p.side === 'LONG' ? 'larga' : 'corta'} desde{' '}
            {p.entry_price} · {p.classification}
            {p.pnl_usd == null ? (
              ' · sin precio para valuarla'
            ) : (
              <>
                {' '}
                ·{' '}
                <span className={p.pnl_usd >= 0 ? 'is-up' : 'is-down'}>
                  {netUsd(p.pnl_usd)}
                </span>{' '}
                ({p.label}, cierre {p.mark_price})
              </>
            )}
          </small>
        ))}
      </div>
    </div>
  )
}

/** The forward result of one strategy: live and recovered apart, progress, open positions, last run, state. */
export function ForwardResult({
  row,
  now,
}: {
  row: InventoryStrategy
  now: number
}) {
  const result = row.forward.trades
  if (result === null)
    return (
      <section className="comparison__block" data-testid="forward-result">
        <h4>Forward paper</h4>
        <em>{row.forward.missing ?? 'Sin lectura del forward'}</em>
        {row.forward.problems.map((p) => (
          <small key={p.code}>{p.reason}</small>
        ))}
      </section>
    )
  const { progress } = result
  const ratio = progress.min_trades
    ? Math.min(100, (progress.live_trades / progress.min_trades) * 100)
    : 0
  const ago = agoText(result.last_run_ms, now)
  return (
    <section className="comparison__block" data-testid="forward-result">
      <h4>Forward paper</h4>
      <p data-testid="forward-state">{stateLine(result.state)}</p>
      <Side title="En vivo" side={result.live} testid="forward-live" />
      <Side
        title="Recuperadas"
        side={result.recovered}
        testid="forward-recovered"
      />
      {result.unclassified_open.count > 0 && (
        <div data-testid="forward-unclassified-open">
          <b>Sin clasificar</b>: {result.unclassified_open.count}
          {result.unclassified_open.positions.map((p) => (
            <small key={p.product_id}>
              {p.product_id} {p.side === 'LONG' ? 'larga' : 'corta'} desde{' '}
              {p.entry_price} · {p.classification}
            </small>
          ))}
        </div>
      )}
      <div data-testid="forward-progress">
        <b>
          {progress.live_trades}/{progress.min_trades ?? '—'}
        </b>{' '}
        operaciones en vivo para el mínimo
        <progress max={100} value={ratio} aria-label="Avance hacia el mínimo" />
        <small>Las recuperadas no cuentan para el mínimo.</small>
      </div>
      <small data-testid="forward-last-run">
        Último ciclo: {ago ?? 'sin ciclos registrados'}
        {result.late && (
          <>
            {' '}
            <StatusPill tone="warn">Atrasado</StatusPill>
          </>
        )}
      </small>
      {result.problems.map((p) => (
        <small key={p.code} className="is-down" data-testid="forward-problem">
          {p.reason}
        </small>
      ))}
    </section>
  )
}
