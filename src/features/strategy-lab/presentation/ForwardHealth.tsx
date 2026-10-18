import { StatusPill } from '../../../shared/mission-control/index.ts'
import {
  agoText,
  Q_SKIP_LABELS,
  SKIP_WINDOW_LABELS,
} from '../domain/forward-text.ts'
import type { ForwardHealth as Health } from '../infrastructure/strategy-api.ts'

/** Compact health block: funding state per product and why Q did not decide. */
export function ForwardHealth({
  health,
  now,
}: {
  health: Health | null
  now: number
}) {
  if (health === null)
    return (
      <p className="comparison__health-off" data-testid="forward-health">
        <b>Salud del forward:</b> el servicio no tiene configurada la lectura
        del forward.
      </p>
    )
  const products = Object.entries(health.funding)
  const skips = health.q_skips
  return (
    <article className="comparison__panel" data-testid="forward-health">
      <h3>
        Salud del forward{' '}
        <small>ciclo cada {Math.round(health.cadence_s / 60)} min</small>
      </h3>
      <h4>Funding por producto</h4>
      {products.length === 0 ? (
        <p>
          {health.summary_available
            ? 'El resumen no trae estado de funding.'
            : 'Sin resumen del forward: no se puede leer el funding.'}
        </p>
      ) : (
        <ul data-testid="funding-list">
          {products.map(([product, state]) => (
            <li key={product}>
              <StatusPill tone={state.usable ? 'ok' : 'warn'}>
                {state.usable ? 'Usable' : 'No usable'}
              </StatusPill>{' '}
              {product}
              {!state.usable && `: ${state.reason}`}
              <small> · {agoText(state.checked_ms, now)}</small>
            </li>
          ))}
        </ul>
      )}
      <h4>Saltos de Q</h4>
      {!skips.available ? (
        <p>{skips.reason}</p>
      ) : (
        <>
          <table data-testid="skip-counts">
            <thead>
              <tr>
                <th>Ventana</th>
                <th>Total</th>
                <th>Por código</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(skips.windows).map(([name, window]) => (
                <tr key={name}>
                  <td>{SKIP_WINDOW_LABELS[name] ?? name}</td>
                  <td>{window.total}</td>
                  <td>
                    {Object.entries(window.by_code)
                      .map(([code, n]) => `${Q_SKIP_LABELS[code] ?? code} ${n}`)
                      .join(' · ') || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {skips.latest.length === 0 ? (
            <p>Q no ha saltado ningún tramo.</p>
          ) : (
            <ul data-testid="skip-latest">
              {skips.latest.slice(0, 5).map((skip, index) => (
                <li key={`${skip.written_at}-${index}`}>
                  {skip.product_id} · {Q_SKIP_LABELS[skip.code] ?? skip.code}:{' '}
                  {skip.reason}
                  <small> · {agoText(skip.written_at, now)}</small>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </article>
  )
}
