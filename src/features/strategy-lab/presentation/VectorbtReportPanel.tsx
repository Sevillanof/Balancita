import { useState } from 'react'
import { count } from '../domain/strategy-format.ts'
import {
  bpText,
  dayText,
  perDayText,
  shareText,
} from '../domain/vectorbt-format.ts'
import type {
  VbtDiagnostic,
  VbtExploration,
  VbtVariant,
  VectorbtApi,
} from '../infrastructure/vectorbt-api.ts'
import { explorationMarkdown } from '../domain/vectorbt-markdown.ts'
import VectorbtCompare from './VectorbtCompare.tsx'

/** Only the first rows of the ranking can be taken to the simulator. */
export const CONFIRMABLE_ROWS = 3

type Props = {
  api: VectorbtApi
  exploration: VbtExploration
  /** All finished explorations with a report, newest first; the user can switch. */
  choices: VbtExploration[]
  onChoose: (id: string) => void
  /** Intentos de la familia hoy (el contador del servidor), `null` si no se pudo leer. */
  attempts: number | null
  /** Creates the draft variant and starts its test; rejects with a Spanish message. */
  onConfirm: (exploration: VbtExploration, row: VbtVariant) => Promise<void>
  /** Value being confirmed right now. */
  confirming: string | null
  problem: string | null
}

const modeText = (exploration: VbtExploration) =>
  exploration.mode === 'diagnostic'
    ? 'Diagnóstico'
    : `Variantes de ${exploration.report?.vary?.label ?? exploration.vary ?? '—'}`

const stamp = (ms: number) =>
  new Date(ms).toLocaleString('es-AR', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })

/**
 * «Reporte de VectorBT» in the strategy card: what works, what fails, the
 * tables by product and by way out, and, with variants, the ranking. Always a
 * quick diagnosis over practice data, never a verdict.
 */
export default function VectorbtReportPanel({
  api,
  exploration,
  choices,
  onChoose,
  attempts,
  onConfirm,
  confirming,
  problem,
}: Props) {
  const [open, setOpen] = useState(true)
  const [comparing, setComparing] = useState<string | null>(null)
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null)
  const report = exploration.report
  if (!report) return null
  const windowText = `${dayText(report.window.from)} a ${dayText(report.window.to)}`
  const tried = attempts ?? report.attempts_in_family

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(
        explorationMarkdown(exploration, attempts),
      )
      setCopied('ok')
    } catch {
      setCopied('fail')
    }
    setTimeout(() => setCopied(null), 2500)
  }

  return (
    <section
      className="vbt-report"
      aria-label="Reporte de VectorBT"
      data-testid="vbt-report"
    >
      <div className="vbt-report__head">
        <h4>Reporte de VectorBT</h4>
        {choices.length > 1 && (
          <select
            aria-label="Exploración"
            value={exploration.id}
            onChange={(event) => onChoose(event.target.value)}
          >
            {choices.map((item) => (
              <option key={item.id} value={item.id}>
                {stamp(item.created_at)} · {modeText(item)}
              </option>
            ))}
          </select>
        )}
        <button type="button" onClick={() => void copy()}>
          {copied === 'ok'
            ? 'Copiado ✓'
            : copied === 'fail'
              ? 'No se pudo copiar'
              : 'Copiar en Markdown'}
        </button>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? 'Ocultar' : 'Mostrar'}
        </button>
      </div>
      <p className="runview__hint" data-testid="vbt-window">
        {modeText(exploration)} · datos de práctica del {windowText} (el examen
        queda intacto). Es un diagnóstico rápido, no un veredicto.
      </p>
      {open && (
        <div className="vbt-report__body">
          {report.status === 'unsupported' || report.diagnostic === null ? (
            <p className="runview__hint" data-testid="vbt-unsupported">
              VectorBT no puede reproducir esta estrategia:{' '}
              {report.unsupported?.reason ?? exploration.detail}. No es un
              problema de la estrategia: para probarla usá Testear, que corre en
              el simulador.
            </p>
          ) : (
            <>
              <Diagnostic diagnostic={report.diagnostic} />
              {report.variants && (
                <Ranking
                  api={api}
                  exploration={exploration}
                  rows={report.variants}
                  headline={report.variants_headline ?? null}
                  label={report.vary?.label ?? exploration.vary ?? ''}
                  attempts={tried}
                  onConfirm={onConfirm}
                  confirming={confirming}
                  comparing={comparing}
                  onCompare={setComparing}
                />
              )}
            </>
          )}
          {problem && (
            <p role="alert" className="runview__warn">
              {problem}
            </p>
          )}
          <p className="runview__warn" data-testid="vbt-warning">
            {report.warning}
          </p>
          <p className="runview__hint">
            pb = punto básico: 1 pb es el 0,01 % de lo operado. Neto es lo que
            queda después de comisiones, costo de ejecución y funding.
          </p>
        </div>
      )}
    </section>
  )
}

function Diagnostic({ diagnostic }: { diagnostic: VbtDiagnostic }) {
  const totals = diagnostic.totals
  return (
    <>
      <dl className="runview__facts" aria-label="Totales">
        <div>
          <dt>Operaciones</dt>
          <dd>{count(totals.trades)}</dd>
        </div>
        <div>
          <dt>Entradas por día</dt>
          <dd>{perDayText(totals.entries_per_day)}</dd>
        </div>
        <div>
          <dt>Antes de costos</dt>
          <dd>{bpText(totals.gross_bp_mean)}</dd>
        </div>
        <div>
          <dt>Neto por operación</dt>
          <dd data-tone={(totals.net_bp_mean ?? 0) < 0 ? 'bad' : 'good'}>
            {bpText(totals.net_bp_mean)}
          </dd>
        </div>
        <div>
          <dt>Aciertos</dt>
          <dd>{shareText(totals.hit_rate)}</dd>
        </div>
      </dl>
      <div className="vbt-report__twin">
        <div>
          <h5>Qué funciona</h5>
          {diagnostic.works.length > 0 ? (
            <ul className="vbt-list">
              {diagnostic.works.map((sentence) => (
                <li key={sentence}>{sentence}</li>
              ))}
            </ul>
          ) : (
            <p className="runview__hint">Nada que destacar por ahora.</p>
          )}
        </div>
        <div>
          <h5>Qué falla</h5>
          {diagnostic.fails.length > 0 ? (
            <ul className="vbt-list">
              {diagnostic.fails.map((sentence) => (
                <li key={sentence}>{sentence}</li>
              ))}
            </ul>
          ) : (
            <p className="runview__hint">No se vio nada que falle.</p>
          )}
        </div>
      </div>
      {diagnostic.by_product.length > 0 && (
        <div className="runview__table-wrap">
          <table className="runview__table" aria-label="Por producto">
            <caption>Por producto</caption>
            <thead>
              <tr>
                <th scope="col">Producto</th>
                <th scope="col" className="runview__num">
                  Operaciones
                </th>
                <th scope="col" className="runview__num">
                  Antes de costos
                </th>
                <th scope="col" className="runview__num">
                  Neto
                </th>
                <th scope="col" className="runview__num">
                  Aciertos
                </th>
              </tr>
            </thead>
            <tbody>
              {diagnostic.by_product.map((row) => (
                <tr key={row.product}>
                  <th scope="row">{row.product}</th>
                  <td className="runview__num">{count(row.trades)}</td>
                  <td className="runview__num">{bpText(row.gross_bp_mean)}</td>
                  <td className="runview__num">{bpText(row.net_bp_mean)}</td>
                  <td className="runview__num">{shareText(row.hit_rate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {diagnostic.by_exit.length > 0 && (
        <div className="runview__table-wrap">
          <table className="runview__table" aria-label="Por tipo de salida">
            <caption>Por tipo de salida</caption>
            <thead>
              <tr>
                <th scope="col">Salida</th>
                <th scope="col" className="runview__num">
                  Operaciones
                </th>
                <th scope="col" className="runview__num">
                  Del total
                </th>
                <th scope="col" className="runview__num">
                  Antes de costos
                </th>
                <th scope="col" className="runview__num">
                  Neto
                </th>
              </tr>
            </thead>
            <tbody>
              {diagnostic.by_exit.map((row) => (
                <tr key={row.reason}>
                  <th scope="row">{row.label}</th>
                  <td className="runview__num">{count(row.trades)}</td>
                  <td className="runview__num">{shareText(row.share)}</td>
                  <td className="runview__num">{bpText(row.gross_bp_mean)}</td>
                  <td className="runview__num">{bpText(row.net_bp_mean)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {diagnostic.notes.length > 0 && (
        <ul
          className="vbt-list vbt-list--notes"
          aria-label="Avisos sobre los datos"
        >
          {diagnostic.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
    </>
  )
}

function Ranking({
  api,
  exploration,
  rows,
  headline,
  label,
  attempts,
  onConfirm,
  confirming,
  comparing,
  onCompare,
}: {
  api: VectorbtApi
  exploration: VbtExploration
  rows: VbtVariant[]
  headline: string | null
  label: string
  attempts: number | null
  onConfirm: Props['onConfirm']
  confirming: string | null
  comparing: string | null
  onCompare: (value: string | null) => void
}) {
  return (
    <div className="vbt-ranking" data-testid="vbt-ranking">
      <h5>Ranking de variantes · {label}</h5>
      {headline && <p className="runview__hint">{headline}</p>}
      <p className="runview__hint" data-testid="vbt-attempts">
        {attempts === null
          ? 'No se pudo leer cuántos intentos lleva esta estrategia.'
          : `Llevás ${attempts} ${attempts === 1 ? 'intento' : 'intentos'} con esta estrategia.`}{' '}
        Son hipótesis: cuanto más se prueba, más fácil es que alguna salga bien
        por casualidad. Lo que importa es cómo le va después en el simulador y
        en el examen.
      </p>
      <div className="runview__table-wrap">
        <table className="runview__table" aria-label="Ranking de variantes">
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Valor</th>
              <th scope="col" className="runview__num">
                Entradas por día
              </th>
              <th scope="col" className="runview__num">
                Neto por operación
              </th>
              <th scope="col" className="runview__num">
                Operaciones
              </th>
              <th scope="col" className="runview__num">
                Aciertos
              </th>
              <th scope="col">&nbsp;</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const created = exploration.confirmed[row.value]
              const canConfirm =
                index < CONFIRMABLE_ROWS &&
                row.status === 'ok' &&
                !row.is_base &&
                !created
              return (
                <tr key={row.value} data-testid="vbt-row">
                  <td>{row.status === 'error' ? '—' : row.rank}</td>
                  <th scope="row">
                    {row.value.replace('.', ',')}
                    {row.is_base && ' (la actual)'}
                  </th>
                  {row.status === 'error' ? (
                    <td colSpan={4} className="runview__hint">
                      No se pudo probar: {row.error ?? 'falló'}
                    </td>
                  ) : row.status === 'no_trades' ? (
                    <td colSpan={4} className="runview__hint">
                      No operó nunca con este valor.
                    </td>
                  ) : (
                    <>
                      <td className="runview__num">
                        {perDayText(row.entries_per_day)}
                      </td>
                      <td className="runview__num">
                        {bpText(row.net_bp_mean)}
                      </td>
                      <td className="runview__num">{count(row.trades)}</td>
                      <td className="runview__num">
                        {shareText(row.hit_rate)}
                      </td>
                    </>
                  )}
                  <td className="vbt-ranking__action">
                    {canConfirm && (
                      <button
                        type="button"
                        disabled={confirming !== null}
                        onClick={() => void onConfirm(exploration, row)}
                      >
                        {confirming === row.value
                          ? 'Creando…'
                          : 'Confirmar en simulador'}
                      </button>
                    )}
                    {created && (
                      <span className="vbt-ranking__made">Ya creada</span>
                    )}
                    {(created || (row.is_base && row.status === 'ok')) && (
                      <button
                        type="button"
                        aria-label={`Ver VectorBT vs simulador de ${row.label}`}
                        onClick={() =>
                          onCompare(comparing === row.value ? null : row.value)
                        }
                      >
                        VectorBT vs simulador
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {comparing !== null && (
        <VectorbtCompare
          api={api}
          strategyId={exploration.strategy_id}
          explorationId={exploration.id}
          value={comparing}
          onClose={() => onCompare(null)}
        />
      )}
    </div>
  )
}
