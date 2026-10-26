import { VBT } from './vectorbt-styles.ts'
import { RUN } from './run-view-styles.ts'
import { useEffect, useState } from 'react'
import {
  bpText,
  dayText,
  perDayText,
  shareText,
} from '../domain/vectorbt-format.ts'
import { count } from '../domain/strategy-format.ts'
import type {
  VbtComparison,
  VbtSide,
  VectorbtApi,
} from '../infrastructure/vectorbt-api.ts'

type Props = {
  api: VectorbtApi
  /** The strategy the exploration was launched on (the route lives under it). */
  strategyId: string
  explorationId: string
  value: string
  runId?: number
  /** Shows a «Cerrar» button. */
  onClose?: () => void
}

const ROWS: Array<{
  label: string
  of: (side: VbtSide) => string
  diff: (diff: VbtComparison['difference']) => string
}> = [
  {
    label: 'Operaciones',
    of: (side) => count(side.trades),
    diff: (diff) =>
      diff.trades == null
        ? '—'
        : `${diff.trades > 0 ? '+' : ''}${count(diff.trades)}`,
  },
  {
    label: 'Entradas por día',
    of: (side) => perDayText(side.entries_per_day),
    diff: (diff) => perDayText(diff.entries_per_day),
  },
  {
    label: 'Antes de costos',
    of: (side) => bpText(side.gross_bp_mean),
    diff: (diff) => bpText(diff.gross_bp_mean),
  },
  {
    label: 'Costos',
    of: (side) => bpText(side.cost_bp_mean),
    diff: (diff) => bpText(diff.cost_bp_mean),
  },
  {
    label: 'Funding',
    of: (side) => bpText(side.funding_bp_mean),
    diff: (diff) => bpText(diff.funding_bp_mean),
  },
  {
    label: 'Resultado neto por operación',
    of: (side) => bpText(side.net_bp_mean),
    diff: (diff) => bpText(diff.net_bp_mean),
  },
  {
    label: 'Aciertos',
    of: (side) => shareText(side.hit_rate),
    diff: (diff) =>
      diff.hit_rate == null
        ? '—'
        : `${diff.hit_rate > 0 ? '+' : ''}${shareText(diff.hit_rate)}`,
  },
]

/** «VectorBT vs simulador», side by side, with the server's own sentences about the difference. */
export default function VectorbtCompare({
  api,
  strategyId,
  explorationId,
  value,
  runId,
  onClose,
}: Props) {
  const [data, setData] = useState<VbtComparison | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    api.compare(strategyId, explorationId, value, runId).then(
      (found) => {
        if (!alive) return
        setData(found)
        setError(null)
      },
      (failure: unknown) => {
        if (alive)
          setError(failure instanceof Error ? failure.message : String(failure))
      },
    )
    return () => {
      alive = false
    }
  }, [api, strategyId, explorationId, value, runId])

  return (
    <section className={VBT.compare} aria-label="VectorBT contra el simulador">
      <div className={VBT.compareHead}>
        <h5>VectorBT vs simulador{data ? ` · ${data.label}` : ''}</h5>
        {onClose && (
          <button type="button" onClick={onClose}>
            Cerrar
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className={RUN.hint} data-testid="vbt-compare-error">
          {error}
        </p>
      )}
      {!error && !data && <p className={RUN.hint}>Comparando…</p>}
      {data && (
        <>
          <div className={RUN.tableWrap}>
            <table className={RUN.table}>
              <caption>
                Las dos columnas miden lo mismo: resultado neto = antes de
                costos − costos − funding, en pb por operación.
              </caption>
              <thead>
                <tr>
                  <th scope="col">&nbsp;</th>
                  <th scope="col" className={RUN.num}>
                    VectorBT
                  </th>
                  <th scope="col" className={RUN.num}>
                    Simulador
                  </th>
                  <th scope="col" className={RUN.num}>
                    Diferencia
                  </th>
                </tr>
              </thead>
              <tbody>
                {ROWS.map((row) => (
                  <tr key={row.label}>
                    <th scope="row">{row.label}</th>
                    <td className={RUN.num}>{row.of(data.vectorbt)}</td>
                    <td className={RUN.num}>{row.of(data.simulator)}</td>
                    <td className={RUN.num}>{row.diff(data.difference)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className={RUN.hint}>
            Ventana de VectorBT: {dayText(data.window.vectorbt.from)} a{' '}
            {dayText(data.window.vectorbt.to)}. Ventana del simulador:{' '}
            {dayText(data.window.simulator.from)} a{' '}
            {dayText(data.window.simulator.to)}. Prueba de práctica #
            {data.run_id}.
          </p>
          {data.explanation.length > 0 && (
            <ul className={VBT.list} aria-label="Por qué difieren">
              {data.explanation.map((sentence) => (
                <li key={sentence}>{sentence}</li>
              ))}
            </ul>
          )}
          {data.warning && (
            <p className={RUN.warn} data-testid="vbt-compare-warning">
              {data.warning}
            </p>
          )}
        </>
      )}
    </section>
  )
}
