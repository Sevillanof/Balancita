import { useCallback, useEffect, useState } from 'react'
import {
  gateApi,
  gateReportUrl,
  type GateApi,
  type GateOverview,
  type GateRun,
} from '../infrastructure/gate-api.ts'
import { LAB_PRODUCTS, DEFAULT_LAB_PRODUCT } from '../domain/products.ts'
import MarkdownView from './MarkdownView.tsx'
import './GatePanel.css'

const DEFAULT_FROM = '2025-01-01'
const POLL_MS = 2000

const KIND_TEXT = { practice: 'práctica', exam: 'examen' } as const

function VerdictBadge({ verdict }: { verdict: string | null }) {
  const tone =
    verdict === 'PASA' ? 'pass' : verdict === 'NO PASA' ? 'fail' : 'none'
  return (
    <span className={`gate__badge gate__badge--${tone}`} data-testid="verdict">
      {verdict ?? 'SIN VEREDICTO'}
    </span>
  )
}

function remaining(etaS: number | null) {
  if (etaS == null) return 'calculando el tiempo restante'
  const minutes = Math.ceil(etaS / 60)
  return minutes < 1 ? 'falta menos de 1 min' : `faltan ~${minutes} min`
}

function day(ms: number) {
  return new Date(ms).toISOString().slice(0, 10)
}

function ReportLinks({
  runId,
  onView,
}: {
  runId: number
  onView: (runId: number) => void
}) {
  return (
    <span className="gate__links">
      <button
        type="button"
        className="gate__button gate__button--small"
        onClick={() => onView(runId)}
      >
        Ver informe
      </button>
      <a className="gate__link" href={gateReportUrl(runId)} download>
        Descargar (.md)
      </a>
    </span>
  )
}

type Props = {
  strategyId: string
  strategyName: string
  api?: GateApi
  pollMs?: number
}

/** Launch the fixed test of a strategy, follow it and read its history. */
export default function GatePanel({
  strategyId,
  strategyName,
  api = gateApi,
  pollMs = POLL_MS,
}: Props) {
  const [data, setData] = useState<GateOverview | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [form, setForm] = useState(false)
  const [confirmExam, setConfirmExam] = useState(false)
  const [from, setFrom] = useState(DEFAULT_FROM)
  const [products, setProducts] = useState<string[]>([DEFAULT_LAB_PRODUCT])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [report, setReport] = useState<{
    runId: number
    text: string | null
    error: string | null
  } | null>(null)

  const viewReport = useCallback(
    async (runId: number) => {
      setReport({ runId, text: null, error: null })
      try {
        const text = await api.report(runId)
        setReport((current) =>
          current?.runId === runId ? { runId, text, error: null } : current,
        )
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        setReport((current) =>
          current?.runId === runId
            ? { runId, text: null, error: detail }
            : current,
        )
      }
    },
    [api],
  )

  const refresh = useCallback(async () => {
    try {
      setData(await api.overview(strategyId))
      setLoadError(null)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    }
  }, [api, strategyId])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
  }, [refresh])

  const active = data?.running != null
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => void refresh(), pollMs)
    return () => clearInterval(timer)
  }, [active, pollMs, refresh])

  const launch = async (exam: boolean) => {
    setBusy(true)
    setMessage(null)
    try {
      await api.start(strategyId, exam ? { exam: true } : { from, products })
      setForm(false)
      setConfirmExam(false)
      await refresh()
    } catch (error) {
      setConfirmExam(false)
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const cancel = async (run: GateRun) => {
    try {
      await api.cancel(run.id)
      await refresh()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const running = data?.running ?? null
  const mine = running?.strategy_id === strategyId
  const runNow = mine
    ? (data?.runs.find((run) => run.id === running.id) ?? null)
    : null
  const other = running != null && !mine
  const blocked = busy || running != null
  const runs = data?.runs ?? []
  const last = runs.find((run) => run.status !== 'running') ?? null
  const attempts = runs.find(
    (run) => run.kind === 'practice' && run.attempts,
  )?.attempts
  const exam = data?.exam
  const examDone = exam?.taken === true
  const percent = Math.max(0, Math.min(100, Math.round(runNow?.progress ?? 0)))

  return (
    <section
      className="detail__module gate"
      data-testid="gate-panel"
      aria-label={`Probar ${strategyName}`}
    >
      <header>
        <h3>
          <span>PRUEBA //</span> Probar esta estrategia
        </h3>
      </header>
      <p className="gate__note">
        La prueba mide la estrategia con reglas fijadas de antemano y deja el
        informe por escrito.
        {attempts != null && (
          <>
            {' '}
            <strong data-testid="attempts">intentos: {attempts}</strong> —
            cuantos más intentos, más exigente el veredicto.
          </>
        )}
      </p>

      {loadError && (
        <p role="alert" className="gate__warn">
          No se pudo leer el historial de pruebas: {loadError}
        </p>
      )}
      {message && (
        <p role="alert" className="gate__warn" data-testid="gate-message">
          {message}
        </p>
      )}
      {other && (
        <p className="gate__hint" data-testid="gate-busy-hint">
          Hay una prueba en curso en {running.strategy_id}. Solo se puede hacer
          una a la vez.
        </p>
      )}

      {runNow && (
        <div className="gate__running" data-testid="gate-running">
          <div className="gate__running-head">
            <span>
              {runNow.kind === 'exam' ? 'Examen final' : 'Prueba'} en curso ·{' '}
              {runNow.phase ?? 'empezando'}
            </span>
            <strong>{percent} %</strong>
          </div>
          <div
            className="gate__bar"
            role="progressbar"
            aria-label="Avance de la prueba"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <div className="gate__bar-fill" style={{ width: `${percent}%` }} />
          </div>
          <div className="gate__running-foot">
            <span>
              {runNow.detail ? `${runNow.detail} · ` : ''}
              {remaining(runNow.eta_s)}
            </span>
            <button
              type="button"
              className="gate__button"
              onClick={() => void cancel(runNow)}
            >
              Cancelar
            </button>
          </div>
        </div>
      )}
      {mine && !runNow && <p className="gate__hint">Empezando la prueba…</p>}

      {!running && last && (
        <div className="gate__result" data-testid="gate-result">
          <span>
            Última {KIND_TEXT[last.kind]} ({day(last.started_at)}):
          </span>
          {last.status === 'done' ? (
            <VerdictBadge verdict={last.verdict} />
          ) : (
            <span className="gate__badge gate__badge--none">
              {last.status === 'cancelled' ? 'CANCELADA' : 'FALLÓ'}
            </span>
          )}
          {last.has_report && (
            <ReportLinks runId={last.id} onView={viewReport} />
          )}
        </div>
      )}

      <div className="gate__actions">
        <button
          type="button"
          className="gate__button gate__button--primary"
          disabled={blocked}
          onClick={() => setForm((open) => !open)}
        >
          Probar estrategia
        </button>
        <button
          type="button"
          className="gate__button"
          disabled={blocked || examDone}
          onClick={() => setConfirmExam(true)}
        >
          Examen final
        </button>
      </div>

      {exam?.taken && (
        <p className="gate__exam" data-testid="gate-exam-taken">
          Examen final rendido el {exam.date}:{' '}
          <VerdictBadge verdict={exam.verdict} />{' '}
          <ReportLinks runId={exam.run_id} onView={viewReport} />
          {!exam.same_version &&
            ' La estrategia cambió después del examen: para otro examen hay que crear una versión nueva.'}
        </p>
      )}

      {form && !blocked && (
        <form
          className="gate__form"
          onSubmit={(event) => {
            event.preventDefault()
            void launch(false)
          }}
        >
          <label>
            Desde (fecha)
            <input
              type="date"
              value={from}
              required
              onChange={(event) => setFrom(event.target.value)}
            />
          </label>
          <fieldset>
            <legend>Productos</legend>
            {LAB_PRODUCTS.map((product) => (
              <label key={product} className="gate__check">
                <input
                  type="checkbox"
                  checked={products.includes(product)}
                  onChange={(event) =>
                    setProducts((current) =>
                      event.target.checked
                        ? [...current, product]
                        : current.filter((item) => item !== product),
                    )
                  }
                />{' '}
                {product}
              </label>
            ))}
          </fieldset>
          <button
            type="submit"
            className="gate__button gate__button--primary"
            disabled={products.length === 0 || from === ''}
          >
            Empezar prueba
          </button>
        </form>
      )}

      {confirmExam && (
        <div className="gate__backdrop">
          <div
            className="gate__dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="gate-exam-title"
          >
            <h4 id="gate-exam-title">Examen final</h4>
            <p>
              El examen usa los últimos meses que la estrategia nunca vio. Se
              puede rendir una sola vez por versión. Para volver a rendirlo hay
              que crear una versión nueva.
            </p>
            <div className="gate__actions">
              <button
                type="button"
                className="gate__button gate__button--primary"
                disabled={busy}
                onClick={() => void launch(true)}
              >
                Rendir el examen
              </button>
              <button
                type="button"
                className="gate__button"
                onClick={() => setConfirmExam(false)}
              >
                No, volver
              </button>
            </div>
          </div>
        </div>
      )}

      {report && (
        <div className="gate__backdrop">
          <div
            className="gate__dialog gate__dialog--report"
            role="dialog"
            aria-modal="true"
            aria-labelledby="gate-report-title"
          >
            <div className="gate__report-head">
              <h4 id="gate-report-title">
                Informe de la corrida #{report.runId}
              </h4>
              <span className="gate__links">
                <a
                  className="gate__link"
                  href={gateReportUrl(report.runId)}
                  download
                >
                  Descargar (.md)
                </a>
                <button
                  type="button"
                  className="gate__button"
                  onClick={() => setReport(null)}
                >
                  Cerrar
                </button>
              </span>
            </div>
            {report.error && (
              <p role="alert" className="gate__warn">
                No se pudo leer el informe: {report.error}
              </p>
            )}
            {report.text === null && !report.error && (
              <p className="gate__hint">Cargando el informe…</p>
            )}
            {report.text !== null && <MarkdownView source={report.text} />}
          </div>
        </div>
      )}

      <details className="gate__history" data-testid="gate-history">
        <summary>Historial de pruebas ({runs.length})</summary>
        {runs.length === 0 ? (
          <p className="gate__hint">Todavía no se hizo ninguna prueba.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Tipo</th>
                <th>Veredicto</th>
                <th>Intentos</th>
                <th>Informe</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id}>
                  <td>{day(run.started_at)}</td>
                  <td>{KIND_TEXT[run.kind]}</td>
                  <td>
                    {run.status === 'done'
                      ? (run.verdict ?? '—')
                      : run.status === 'running'
                        ? 'en curso'
                        : run.status === 'cancelled'
                          ? 'cancelada'
                          : 'falló'}
                  </td>
                  <td>{run.attempts ?? '—'}</td>
                  <td>
                    {run.has_report ? (
                      <ReportLinks runId={run.id} onView={viewReport} />
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </details>
    </section>
  )
}
