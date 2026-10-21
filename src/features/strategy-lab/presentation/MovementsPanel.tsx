import { useCallback, useEffect, useState } from 'react'
import {
  percent,
  price,
  signedPercent,
  signedUsd,
  utcDateTime,
} from '../../../shared/finance/format.ts'
import {
  loadMovements,
  type Movement,
  type MovementSource,
  type MovementsQuery,
  type MovementsReport,
  type MovementStatus,
} from '../infrastructure/movements-api.ts'

const PAGE = 25
const REFRESH_MS = 10_000
const NAMES: Record<MovementSource, string> = { qwen: 'Qwen', kronos: 'Kronos' }
const SIDES = { LONG: 'Largo', SHORT: 'Corto' } as const

const money = (value: number | null) =>
  value === null ? '—' : signedUsd(value)
const px = (value: string | null) => {
  if (value === null) return '—'
  const n = Number(value)
  return Number.isFinite(n) ? price(n) : value
}

/** Por qué abrió y qué decidió, en palabras llanas. */
function why(m: Movement): string {
  if (m.source === 'kronos' && m.forecast) {
    const dir = m.forecast.expected_bp >= 0 ? 'subida' : 'bajada'
    return `Pronosticó una ${dir} de ${Math.abs(m.forecast.expected_bp).toFixed(0)} pb en 4 h (umbral ${m.forecast.threshold_bp.toFixed(0)} pb)${
      m.status === 'closed' ? '. Cerró a las 4 h.' : ''
    }`
  }
  const d = m.decision
  const answer =
    d?.answer === 'close'
      ? 'cerrar'
      : d?.answer === 'hold'
        ? 'mantener'
        : (d?.answer ?? null)
  const prob =
    d?.probability != null ? ` (${percent(d.probability * 100)})` : ''
  const open = m.open_reason
    ? `Abrió por ${m.open_reason.replace('@', ' de ')}. `
    : ''
  if (m.status === 'closed')
    return `${open}${answer ? `Qwen decidió ${answer}${prob}.` : m.close_reason === 'liquidation' ? 'Liquidada.' : ''}`.trim()
  return `${open}${answer ? `Última decisión de Qwen: ${answer}${prob}.` : 'Sin decisión nueva todavía.'}`.trim()
}

function emptyText(report: MovementsReport, source: MovementSource): string {
  if (report.status === 'unreachable')
    return 'No se pudo conectar con el servidor. Se reintenta solo.'
  if (report.status === 'error')
    return `No se pudieron leer los movimientos (${report.reason}).`
  if (report.sources[source] === 'off')
    return source === 'qwen'
      ? 'Todavía no hay datos de Qwen: el programa que lo ejecuta no ha guardado nada (puede estar apagado o sin el modelo).'
      : 'Todavía no hay datos de Kronos: corre por separado y no ha guardado nada todavía.'
  return source === 'qwen'
    ? 'Qwen aún no ha abierto ninguna posición: solo entra cuando una estrategia da señal y solo cierra cuando él lo decide.'
    : `Kronos aún no ha operado${report.summary?.kronos.forecasts_without_trade ? `: hizo ${report.summary.kronos.forecasts_without_trade} pronósticos pero ninguno superó el umbral` : ''}. Opera solo si el pronóstico supera el doble del costo.`
}

export default function MovementsPanel({
  initialSource = 'qwen',
  load = loadMovements,
}: {
  initialSource?: MovementSource
  load?: (query: MovementsQuery) => Promise<MovementsReport>
}) {
  const [source, setSource] = useState<MovementSource>(initialSource)
  const [status, setStatus] = useState<MovementStatus | ''>('')
  const [product, setProduct] = useState('')
  const [page, setPage] = useState(0)
  const [report, setReport] = useState<MovementsReport | null>(null)

  const refresh = useCallback(
    (active: () => boolean) =>
      load({
        source,
        status: status || undefined,
        product: product || undefined,
        limit: PAGE,
        offset: page * PAGE,
      }).then((next) => {
        if (active()) setReport(next)
      }),
    [load, source, status, product, page],
  )

  useEffect(() => {
    let live = true
    const active = () => live
    void refresh(active)
    const timer = setInterval(() => void refresh(active), REFRESH_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [refresh])

  const summary = report?.summary?.[source] ?? null
  const items = report?.items ?? []
  const pages = report ? Math.max(1, Math.ceil(report.total / PAGE)) : 1
  const products = [...new Set(items.map((m) => m.product_id))]

  return (
    <section
      className="strategy-lab__panel strategy-lab__movements"
      aria-label="Movimientos de Qwen y Kronos"
    >
      <div className="strategy-lab__panel-head">
        <h2>Movimientos</h2>
        <div
          role="tablist"
          aria-label="Modelo"
          className="strategy-lab__move-tabs"
        >
          {(['qwen', 'kronos'] as const).map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={source === name}
              onClick={() => {
                setSource(name)
                setPage(0)
                setReport(null)
              }}
            >
              {NAMES[name]}
            </button>
          ))}
        </div>
        <span className="strategy-lab__context">
          Dinero de práctica · se actualiza cada 10 s
        </span>
      </div>

      {summary && (
        <div className="strategy-lab__kpis" aria-label="Resumen">
          <div className="strategy-lab__kpi">
            <span className="strategy-lab__eyebrow">Operaciones</span>
            <strong className="strategy-lab__num">{summary.operations}</strong>
          </div>
          <div className="strategy-lab__kpi">
            <span className="strategy-lab__eyebrow">Abiertas</span>
            <strong className="strategy-lab__num">{summary.open}</strong>
          </div>
          <div className="strategy-lab__kpi">
            <span className="strategy-lab__eyebrow">Acierto</span>
            <strong className="strategy-lab__num">
              {summary.hit_rate === null
                ? '—'
                : percent(summary.hit_rate * 100)}
            </strong>
            <span className="strategy-lab__num">
              {summary.wins} de {summary.closed} cerradas
            </span>
          </div>
          <div className="strategy-lab__kpi strategy-lab__kpi--key">
            <span className="strategy-lab__eyebrow">Resultado total</span>
            <strong
              className={`strategy-lab__num ${summary.net_usd >= 0 ? 'is-up' : 'is-down'}`}
            >
              {signedUsd(summary.net_usd)}
            </strong>
          </div>
        </div>
      )}

      <div className="strategy-lab__move-filters">
        <label>
          Estado{' '}
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as MovementStatus | '')
              setPage(0)
            }}
          >
            <option value="">Todas</option>
            <option value="open">Abiertas</option>
            <option value="closed">Cerradas</option>
          </select>
        </label>
        <label>
          Producto{' '}
          <select
            value={product}
            onChange={(e) => {
              setProduct(e.target.value)
              setPage(0)
            }}
          >
            <option value="">Todos</option>
            {[...new Set([...products, ...(product ? [product] : [])])].map(
              (id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ),
            )}
          </select>
        </label>
      </div>

      {!report ? (
        <p className="strategy-lab__empty" role="status">
          Cargando movimientos…
        </p>
      ) : items.length === 0 ? (
        <p className="strategy-lab__empty" role="status">
          {emptyText(report, source)}
        </p>
      ) : (
        <div className="strategy-lab__move-scroll">
          <table className="strategy-lab__qwen-table strategy-lab__move-table">
            <thead>
              <tr>
                <th>Abrió</th>
                <th>Cerró</th>
                <th>Producto</th>
                <th>Dirección</th>
                <th className="is-num">Entrada</th>
                <th className="is-num">Salida</th>
                <th className="is-num">Tamaño</th>
                <th className="is-num">Comisiones</th>
                <th className="is-num">Funding</th>
                <th className="is-num">Resultado</th>
                <th>Motivo</th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody>
              {items.map((m) => (
                <tr
                  key={m.id}
                  className={m.status === 'open' ? 'is-open' : undefined}
                >
                  <td>{utcDateTime(m.opened_at_ms)}</td>
                  <td>
                    {m.closed_at_ms === null
                      ? '—'
                      : utcDateTime(m.closed_at_ms)}
                  </td>
                  <td>{m.product_id}</td>
                  <td>{SIDES[m.side]}</td>
                  <td className="is-num">{px(m.entry_price)}</td>
                  <td className="is-num">{px(m.exit_price)}</td>
                  <td className="is-num">{m.notional_usd} US$</td>
                  <td className="is-num">
                    {m.fees_usd === null ? '—' : `${m.fees_usd.toFixed(2)} US$`}
                  </td>
                  <td
                    className="is-num"
                    title={
                      m.funding_status === 'not_charged'
                        ? 'Este modelo no descuenta funding'
                        : undefined
                    }
                  >
                    {m.funding_status === 'not_charged'
                      ? 'no se descuenta'
                      : m.funding_usd === null
                        ? 'sin dato'
                        : `${m.funding_usd.toFixed(2)} US$`}
                  </td>
                  <td
                    className={`is-num ${(m.net_usd ?? 0) >= 0 ? 'is-up' : 'is-down'}`}
                  >
                    {money(m.net_usd)}
                    {m.net_pct !== null && (
                      <small> {signedPercent(m.net_pct, 2)}</small>
                    )}
                  </td>
                  <td>{why(m)}</td>
                  <td>
                    <b>{m.status === 'open' ? 'Abierta' : 'Cerrada'}</b>
                    {m.status === 'open' && m.net_usd !== null && (
                      <small> (valor ahora)</small>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {report && report.total > PAGE && (
        <div className="strategy-lab__move-pager">
          <button
            type="button"
            disabled={page === 0}
            onClick={() => setPage(page - 1)}
          >
            Anteriores
          </button>
          <span>
            Página {page + 1} de {pages}
          </span>
          <button
            type="button"
            disabled={page + 1 >= pages}
            onClick={() => setPage(page + 1)}
          >
            Siguientes
          </button>
        </div>
      )}
    </section>
  )
}
