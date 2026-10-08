import type {
  QwenDecisionStats,
  QwenOption,
  QwenProduct,
  QwenScores,
} from '../infrastructure/qwen-scores.ts'
import {
  percent,
  price,
  signedPercent,
  signedUsd,
  utcTime,
} from '../../../shared/finance/format.ts'
import { MODEL_TEXTS, type ModelKey } from './strategy-lab-labels.ts'

const OPTION_LABELS: Record<QwenOption, string> = {
  buy: 'Comprar',
  hold: 'Mantener',
  sell: 'Vender',
}
const OPTIONS: readonly QwenOption[] = ['buy', 'hold', 'sell']
const SIDE_LABELS = { LONG: 'Compra', SHORT: 'Venta' } as const

function formatPrice(value: string | null) {
  if (value === null) return '—'
  const parsed = Number(value)
  return Number.isFinite(parsed) ? price(parsed) : value
}

/** Net return on the notional (costs included), `+0,12 %`. */
function returnText(netBp: number) {
  return (
    <b className={netBp >= 0 ? 'is-up' : 'is-down'}>
      {signedPercent(netBp / 100, 2)}
    </b>
  )
}

function signed(value: number) {
  return value > 0 ? `+${value}` : value < 0 ? `−${Math.abs(value)}` : '0'
}

function hitRate(stats: QwenDecisionStats | undefined) {
  return stats?.hit_rate === null || stats?.hit_rate === undefined
    ? '—'
    : percent(stats.hit_rate * 100)
}

/**
 * Head and KPIs of the focus panel when a model scored in Qwen's format
 * (Qwen by default, or Kronos) is the selected row.
 */
export function QwenFocusHead({
  scores,
  product,
  model = 'qwen',
}: {
  scores: QwenScores | null
  product: QwenProduct | undefined
  model?: ModelKey
}) {
  const texts = MODEL_TEXTS[model]
  return (
    <>
      <div className="strategy-lab__panel-head">
        <h2>{texts.name}</h2>
        <span className={`strategy-lab__chip strategy-lab__chip--${model}`}>
          {texts.chip}
        </span>
        <span className="strategy-lab__context">
          {product ? texts.context(product.horizon_min) : ''}
        </span>
      </div>
      {!product ? (
        <p className="strategy-lab__empty" role="status">
          {texts.emptyText(scores)}
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
            {product.baseline?.always_hold_rate != null && (
              <span className="strategy-lab__num">
                Siempre «mantener»:{' '}
                {percent(product.baseline.always_hold_rate * 100)}
              </span>
            )}
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

/** Right column when the model is selected: breakdown and latest decisions. */
export function QwenSide({
  product,
  model = 'qwen',
}: {
  product: QwenProduct | undefined
  model?: ModelKey
}) {
  const texts = MODEL_TEXTS[model]
  const open = product?.open_position ?? null
  const closed = (product?.trades ?? []).slice(-12).reverse()
  return (
    <aside
      className="strategy-lab__panel strategy-lab__editor"
      aria-label={`Decisiones de ${texts.name}`}
    >
      <div className="strategy-lab__panel-head">
        <h2>Decisiones de {texts.name}</h2>
      </div>
      <p className="strategy-lab__description">{texts.description}</p>
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
            {open && (
              <li key="open">
                <b>Abierta</b> · {SIDE_LABELS[open.side]} ·{' '}
                <span className="strategy-lab__num">
                  {utcTime(open.entry_time_ms / 1000)}
                </span>{' '}
                · entrada {formatPrice(open.entry_price)}
                {open.mark_price !== null && (
                  <> · ahora {formatPrice(open.mark_price)}</>
                )}
                {open.net_bp !== null && <> · {returnText(open.net_bp)}</>}
              </li>
            )}
            {closed.map((trade) => (
              <li key={`${trade.entry_time_ms}-${trade.exit_time_ms}`}>
                {SIDE_LABELS[trade.side]} ·{' '}
                <span className="strategy-lab__num">
                  {utcTime(trade.entry_time_ms / 1000)}
                </span>{' '}
                · entrada {formatPrice(trade.entry_price)} · cierre{' '}
                {formatPrice(trade.exit_price)} · {returnText(trade.net_bp)}
              </li>
            ))}
            {!open && closed.length === 0 && <li>{texts.noTrades}</li>}
          </ul>
        </>
      )}
    </aside>
  )
}
