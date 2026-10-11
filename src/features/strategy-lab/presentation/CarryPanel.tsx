import { useEffect, useState } from 'react'
import {
  loadCarry as defaultLoad,
  setCarryEnabled as defaultSet,
  type CarrySummary,
} from '../infrastructure/carry-api.ts'
import { utcTime } from '../../../shared/finance/format.ts'

type Props = {
  load?: () => Promise<CarrySummary | null>
  setEnabled?: (enabled: boolean) => Promise<CarrySummary | null>
}

function usd(value: number) {
  const text = Math.abs(value).toFixed(2).replace('.', ',')
  return `${value < 0 ? '−' : value > 0 ? '+' : ''}${text} USD`
}

/** Paper counter of the funding carry; "Desactivar" freezes it, "Activar" restarts it. */
export default function CarryPanel({
  load = defaultLoad,
  setEnabled = defaultSet,
}: Props) {
  const [summary, setSummary] = useState<CarrySummary | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let active = true
    void load().then((loaded) => active && setSummary(loaded))
    return () => {
      active = false
    }
  }, [load])
  if (!summary) return null
  const totals = summary.totals
  const toggle = async () => {
    setBusy(true)
    const next = await setEnabled(!summary.enabled)
    if (next) setSummary(next)
    setBusy(false)
  }
  return (
    <section
      className="strategy-lab__panel strategy-lab__carry"
      aria-label="Carry de funding"
    >
      <div className="strategy-lab__panel-head">
        <h2>{summary.name}</h2>
        <span className="strategy-lab__chip strategy-lab__chip--preview">
          {summary.enabled ? 'en seguimiento' : 'desactivada'}
        </span>
        <button type="button" disabled={busy} onClick={() => void toggle()}>
          {summary.enabled ? 'Desactivar' : 'Activar'}
        </button>
      </div>
      <p className="strategy-lab__carry-label">{summary.label}</p>
      <p>{summary.note}</p>
      {totals ? (
        <>
          <p>
            Desde {summary.start_ms ? utcTime(summary.start_ms) : '—'} · 100 USD
            por producto · {summary.closed_or_open_cycles} ciclos · funding{' '}
            {usd(totals.funding_usd)} · base {usd(totals.basis_usd)} · costes{' '}
            {usd(-totals.costs_usd)} · <b>neto {usd(totals.net_usd)}</b>
          </p>
          <table>
            <thead>
              <tr>
                <th>Producto</th>
                <th>Ciclos</th>
                <th>Horas activas</th>
                <th>Horas sin dato</th>
                <th>Funding</th>
                <th>Neto</th>
              </tr>
            </thead>
            <tbody>
              {summary.products.map((p) => (
                <tr key={p.product_id}>
                  <td>{p.product_id}</td>
                  <td>
                    {p.cycles}
                    {p.open ? ' (abierto)' : ''}
                  </td>
                  <td>{p.active_hours}</td>
                  <td>{p.unknown_hours}</td>
                  <td>{usd(p.funding_usd)}</td>
                  <td>{usd(p.net_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : (
        <p>
          Aún sin resultados: el contador empieza a medir a la próxima hora.
        </p>
      )}
    </section>
  )
}
