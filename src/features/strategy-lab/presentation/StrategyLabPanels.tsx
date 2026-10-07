import type { StrategySpec } from '../domain/strategy-spec.ts'
import type {
  BacktestTrade,
  StrategyDetail,
  StrategyState,
} from '../infrastructure/strategy-api.ts'
import { price, signedUsd, utcTime } from '../../../shared/finance/format.ts'
import { EXIT_LABELS, STATE_LABELS } from './strategy-lab-labels.ts'

function downloadJson(spec: StrategySpec) {
  const blob = new Blob([`${JSON.stringify(spec, null, 2)}\n`], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${spec.id}.v${spec.version}.json`
  link.click()
  URL.revokeObjectURL(url)
}

export function JsonTab({
  draft,
  jsonText,
  onChange,
  onApply,
}: {
  draft: StrategySpec
  jsonText: string | null
  onChange: (text: string) => void
  onApply: () => void
}) {
  return (
    <div className="strategy-lab__tab-body">
      <textarea
        aria-label="JSON de la estrategia"
        className="strategy-lab__json"
        value={jsonText ?? JSON.stringify(draft, null, 2)}
        onChange={(event) => onChange(event.target.value)}
        rows={16}
        spellCheck={false}
      />
      <div className="strategy-lab__row-actions">
        <button
          type="button"
          className="strategy-lab__button"
          disabled={jsonText === null}
          onClick={onApply}
        >
          Aplicar JSON
        </button>
        <button
          type="button"
          className="strategy-lab__button strategy-lab__button--ghost"
          onClick={() => downloadJson(draft)}
        >
          Exportar JSON
        </button>
      </div>
    </div>
  )
}

export function VersionsTab({
  detail,
  busy,
  onState,
}: {
  detail: StrategyDetail
  busy: boolean
  onState: (state: StrategyState) => void
}) {
  return (
    <div className="strategy-lab__tab-body">
      <ul className="strategy-lab__versions">
        {detail.versions.map((entry) => (
          <li key={entry.version}>
            <b>v{entry.version}</b> · {STATE_LABELS[entry.state]}
            {entry.parent
              ? ` · de ${entry.parent.id} v${entry.parent.version}`
              : ''}
          </li>
        ))}
      </ul>
      <div className="strategy-lab__row-actions">
        {detail.state === 'draft' && (
          <button
            type="button"
            className="strategy-lab__button"
            disabled={busy}
            onClick={() => onState('shadow')}
          >
            Pasar a sombra
          </button>
        )}
        {detail.state === 'shadow' && (
          <button
            type="button"
            className="strategy-lab__button strategy-lab__button--primary"
            disabled={busy}
            onClick={() => onState('active')}
          >
            Activar
          </button>
        )}
        {detail.state !== 'retired' && (
          <button
            type="button"
            className="strategy-lab__button strategy-lab__button--ghost"
            disabled={busy}
            onClick={() => onState('retired')}
          >
            Retirar
          </button>
        )}
      </div>
      <small className="strategy-lab__context">
        Activar pide pasar por sombra, 30 trades fuera de muestra, neto medio
        positivo y Sharpe deflactado ≥ 0,95.
      </small>
    </div>
  )
}

export function TradesTable({ trades }: { trades: BacktestTrade[] }) {
  if (trades.length === 0) return null
  return (
    <details className="strategy-lab__panel strategy-lab__trades">
      <summary>Trades ({trades.length})</summary>
      <div className="strategy-lab__table-wrap">
        <table>
          <thead>
            <tr>
              <th>Entrada UTC</th>
              <th>Lado</th>
              <th className="is-num">Precio</th>
              <th className="is-num">Salida</th>
              <th>Motivo</th>
              <th className="is-num">Neto</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((trade, index) => (
              <tr key={index}>
                <td className="strategy-lab__num">
                  {utcTime(trade.entry_time_ms / 1000)}
                </td>
                <td className={trade.side === 'LONG' ? 'is-up' : 'is-down'}>
                  {trade.side === 'LONG' ? 'Largo' : 'Corto'}
                </td>
                <td className="strategy-lab__num is-num">
                  {price(Number(trade.entry_price))}
                </td>
                <td className="strategy-lab__num is-num">
                  {price(Number(trade.exit_price))}
                </td>
                <td>{EXIT_LABELS[trade.exit_reason] ?? trade.exit_reason}</td>
                <td
                  className={`strategy-lab__num is-num ${trade.pnl_usd > 0 ? 'is-up' : 'is-down'}`}
                >
                  {signedUsd(trade.pnl_usd)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  )
}
