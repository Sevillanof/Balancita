import type {
  QwenDecisionStats,
  QwenOption,
  QwenProduct,
  QwenScores,
} from '../infrastructure/qwen-scores.ts'
import { percent, signedPercent, signedUsd, utcTime } from '../../../shared/finance/format.ts'

const OPTION_LABELS: Record<QwenOption, string> = {
  buy: 'Comprar',
  hold: 'Mantener',
  sell: 'Vender',
}
const OPTIONS: readonly QwenOption[] = ['buy', 'hold', 'sell']

function signed(value: number) {
  return value > 0 ? `+${value}` : value < 0 ? `−${Math.abs(value)}` : '0'
}

function hitRate(stats: QwenDecisionStats | undefined) {
  return stats?.hit_rate === null || stats?.hit_rate === undefined
    ? '—'
    : percent(stats.hit_rate * 100)
}

function qwenEmptyText(scores: QwenScores | null): string {
  if (!scores) return 'Cargando el puntaje de Qwen…'
  if (scores.status === 'off')
    return scores.reason === 'decisions_or_verdicts_db_missing'
      ? 'Qwen todavía no guardó decisiones: el puntaje aparece con la primera.'
      : 'El puntaje de Qwen no está disponible: el gateway en vivo no respondió.'
  if (scores.status === 'error')
    return `No se pudo calcular el puntaje de Qwen${scores.reason ? ` (${scores.reason})` : ''}.`
  return 'Qwen todavía no tiene decisiones para PF_XBTUSD.'
}

/** Head and KPIs of the focus panel when Qwen is the selected row. */
export function QwenFocusHead({
  scores,
  product,
}: {
  scores: QwenScores | null
  product: QwenProduct | undefined
}) {
  return (
    <>
      <div className="strategy-lab__panel-head">
        <h2>Qwen</h2>
        <span className="strategy-lab__chip strategy-lab__chip--qwen">
          Decide sobre las estrategias
        </span>
        <span className="strategy-lab__context">
          {product
            ? `Cada decisión se juzga a ${product.horizon_min} min con comisiones · mismo book y costos que el backtest · todas las decisiones guardadas`
            : ''}
        </span>
      </div>
      {!product ? (
        <p className="strategy-lab__empty" role="status">
          {qwenEmptyText(scores)}
        </p>
      ) : (
        <div className="strategy-lab__kpis">
          <div className="strategy-lab__kpi strategy-lab__kpi--key">
            <span className="strategy-lab__eyebrow">Rentabilidad</span>
            <strong
              className={`strategy-lab__num ${product.trading.return_pct >= 0 ? 'is-up' : 'is-down'}`}
            >
              {signedPercent(product.trading.return_pct, 2)}
            </strong>
            <span className="strategy-lab__num">
              {signedUsd(product.trading.pnl_usd)} · {product.trading.trades}{' '}
              trades
            </span>
          </div>
          <div className="strategy-lab__kpi strategy-lab__kpi--key">
            <span className="strategy-lab__eyebrow">Acierto</span>
            <strong className="strategy-lab__num">
              {hitRate(product.decisions)}
            </strong>
            <span className="strategy-lab__num">
              {product.decisions.hits} de {product.decisions.scored} decisiones
            </span>
          </div>
          <div className="strategy-lab__kpi">
            <span className="strategy-lab__eyebrow">Puntaje</span>
            <strong
              className={`strategy-lab__num ${product.decisions.points >= 0 ? 'is-up' : 'is-down'}`}
            >
              {signed(product.decisions.points)}
            </strong>
            <span className="strategy-lab__num">
              <span className="is-up">+{product.decisions.hits}</span> ·{' '}
              <span className="is-down">−{product.decisions.misses}</span>
              {product.decisions.pending > 0
                ? ` · ${product.decisions.pending} pendientes`
                : ''}
            </span>
          </div>
          <div className="strategy-lab__kpi">
            <span className="strategy-lab__eyebrow">Caída máxima</span>
            <strong className="strategy-lab__num is-down">
              {product.trading.max_drawdown.pct === null
                ? '—'
                : signedPercent(product.trading.max_drawdown.pct, 2)}
            </strong>
          </div>
          <div className="strategy-lab__kpi">
            <span className="strategy-lab__eyebrow">
              Comprar · mantener · vender
            </span>
            <strong className="strategy-lab__num strategy-lab__qwen-split">
              {OPTIONS.map((option) => hitRate(product.by_option[option])).join(
                ' · ',
              )}
            </strong>
            <span className="strategy-lab__num">acierto por respuesta</span>
          </div>
        </div>
      )}
    </>
  )
}

/** Right column when Qwen is selected: breakdown and latest decisions. */
export function QwenSide({ product }: { product: QwenProduct | undefined }) {
  const latest = (product?.rows ?? []).slice(-12).reverse()
  return (
    <aside
      className="strategy-lab__panel strategy-lab__editor"
      aria-label="Decisiones de Qwen"
    >
      <div className="strategy-lab__panel-head">
        <h2>Decisiones de Qwen</h2>
      </div>
      <p className="strategy-lab__description">
        Qwen elige comprar, mantener o vender mirando lo que proponen las
        estrategias. Cada acierto suma +1 y cada fallo −1.
      </p>
      {product && (
        <>
          <table className="strategy-lab__qwen-table">
            <thead>
              <tr>
                <th>Respuesta</th>
                <th className="is-num">+1</th>
                <th className="is-num">−1</th>
                <th className="is-num">Neto</th>
                <th className="is-num">Acierto</th>
              </tr>
            </thead>
            <tbody>
              {OPTIONS.map((option) => {
                const stats = product.by_option[option]
                return (
                  <tr key={option}>
                    <td>{OPTION_LABELS[option]}</td>
                    <td className="strategy-lab__num is-num is-up">
                      {stats?.hits ?? 0}
                    </td>
                    <td className="strategy-lab__num is-num is-down">
                      {stats?.misses ?? 0}
                    </td>
                    <td className="strategy-lab__num is-num">
                      {signed(stats?.points ?? 0)}
                    </td>
                    <td className="strategy-lab__num is-num">
                      {hitRate(stats)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <h3 className="strategy-lab__eyebrow">Últimas decisiones</h3>
          <ul className="strategy-lab__versions">
            {latest.map((row) => (
              <li key={row.bucket_start}>
                <span className="strategy-lab__num">
                  {utcTime(row.bucket_start / 1000)}
                </span>{' '}
                · {OPTION_LABELS[row.chosen] ?? row.chosen} ·{' '}
                {row.point === null ? (
                  'pendiente'
                ) : (
                  <b className={row.point > 0 ? 'is-up' : 'is-down'}>
                    {row.point > 0 ? '+1' : '−1'}
                  </b>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </aside>
  )
}
