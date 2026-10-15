import { useEffect, useMemo, useState } from 'react'
import { DataState } from '../../../shared/mission-control/index.ts'
import {
  fetchCandles,
  type CandlesReport,
} from '../infrastructure/candles-api.ts'
import ContextCandlesChart, {
  type ContextMarker,
} from './ContextCandlesChart.tsx'
import {
  CONTEXT_INTERVALS,
  contextRange,
  contextSeries,
} from './context-candles-view.ts'
import {
  actionLabel,
  isDirectional,
  utcClock,
  utcMinute,
} from './decisions-view.ts'

type Loaded =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; report: CandlesReport; at: number }

/**
 * 1 m first; only when the source answered and holds no 1 m candle in the
 * range, 5 m. An unreadable source or an error is not retried at another
 * interval: the cause is shown as it is.
 */
async function loadContext(
  product: string,
  bucketMs: number,
  signal: AbortSignal,
): Promise<CandlesReport> {
  let last: CandlesReport | null = null
  for (const interval of CONTEXT_INTERVALS) {
    const range = contextRange(bucketMs, interval.ms, Date.now())
    last = await fetchCandles(
      { product, interval: interval.id, ...range },
      signal,
    )
    if (last.candles.state !== 'ok' || last.candles.count > 0) return last
  }
  return last as CandlesReport
}

/**
 * Context candles around the chosen decision, with a marker at its minute.
 * The marker carries the action and the registered `reason_code` only: a
 * discard names no strategy. Nothing after the decision is evaluated here:
 * later candles are just the ones the source holds, labelled as observed.
 */
export default function DecisionContext({
  product,
  bucketStartMs,
  action,
  reasonCode,
}: {
  product: string
  bucketStartMs: number
  action: string
  reasonCode: string
}) {
  const key = `${product}|${bucketStartMs}`
  const [result, setResult] = useState<{ key: string; loaded: Loaded } | null>(
    null,
  )
  useEffect(() => {
    const abort = new AbortController()
    loadContext(product, bucketStartMs, abort.signal)
      .then((report) => {
        if (!abort.signal.aborted)
          setResult({
            key,
            loaded: { state: 'ready', report, at: Date.now() },
          })
      })
      .catch((cause: unknown) => {
        if (!abort.signal.aborted)
          setResult({
            key,
            loaded: {
              state: 'error',
              message:
                cause instanceof Error ? cause.message : 'error desconocido',
            },
          })
      })
    return () => abort.abort()
  }, [key, product, bucketStartMs])
  const loaded: Loaded =
    result && result.key === key ? result.loaded : { state: 'loading' }

  const report = loaded.state === 'ready' ? loaded.report : null
  const series = useMemo(
    () => (report ? contextSeries(report, bucketStartMs) : null),
    [report, bucketStartMs],
  )
  const marker = useMemo<ContextMarker>(
    () => ({
      text: `${action} · ${reasonCode}${
        series && series.minutesAfterInMarker > 0
          ? ` · vela con ${series.minutesAfterInMarker} min posteriores`
          : ''
      }`,
      tone:
        action === 'LONG' ? 'long' : action === 'SHORT' ? 'short' : 'neutral',
    }),
    [action, reasonCode, series],
  )

  return (
    <section
      className="inv-panel inv-context"
      aria-label="Velas de contexto de la decisión"
      data-testid="context-panel"
    >
      <div className="inv-context__head">
        <p className="inv-label">
          Velas de contexto · {product}
          {report?.candles.state === 'ok' && ` · ${report.interval}`}
        </p>
        <p className="inv-context__decision" data-testid="context-decision">
          Decisión de las {utcMinute(bucketStartMs)} ·{' '}
          <b>{actionLabel(action)}</b> · <code>{reasonCode}</code>
          {!isDirectional(action) && ' · sin estrategia atribuida'}
        </p>
      </div>
      {loaded.state === 'loading' && <DataState kind="loading" />}
      {loaded.state === 'error' && (
        <DataState
          kind="error"
          title="No se pudieron leer las velas"
          detail={loaded.message}
        />
      )}
      {report?.candles.state === 'unavailable' && (
        <DataState
          kind="unavailable"
          title="Sin datos de velas"
          detail={`Origen ${report.candles.evidence.origin ?? 'sin configurar'}: ${report.candles.detail}`}
        />
      )}
      {report?.candles.state === 'ok' && report.candles.count === 0 && (
        <DataState
          kind="nodata"
          title="Sin velas en el rango"
          detail={`La fuente se leyó y no tiene velas de ${report.interval} de ${product} entre ${utcClock(report.fromMs)} y ${utcClock(report.toMs)}.`}
        />
      )}
      {report &&
        series &&
        report.candles.state === 'ok' &&
        report.candles.count > 0 && (
          <>
            <ContextCandlesChart
              series={series}
              marker={marker}
              ariaLabel={`Velas de ${report.interval} de ${product} alrededor de la decisión de las ${utcMinute(bucketStartMs)}`}
            />
            <ul className="inv-context__notes" data-testid="context-notes">
              {report.truncated && (
                <li data-testid="context-truncated">
                  El rango se acortó por el límite de {report.limit} velas: se
                  muestran desde las {utcClock(report.fromMs)}.
                </li>
              )}
              {series.decisionCandle && series.minutesAfterInMarker > 0 && (
                <li data-testid="context-coarse-candle">
                  La vela de {report.interval} de la decisión incluye{' '}
                  {series.minutesAfterInMarker} min posteriores a las{' '}
                  {utcMinute(bucketStartMs)}: no es solo información anterior a
                  la decisión.
                </li>
              )}
              {!series.decisionCandle && (
                <li data-testid="context-no-decision-candle">
                  No hay vela guardada del minuto de la decisión (
                  {utcMinute(bucketStartMs)}); no se dibuja marcador sobre un
                  dato que no existe. Si la decisión es reciente, la vela
                  oficial puede no estar guardada todavía: no es un error.
                </li>
              )}
              {series.gapTimes.length > 0 && (
                <li data-testid="context-gaps">
                  {series.gapTimes.length}{' '}
                  {series.gapTimes.length === 1
                    ? 'vela sin dato'
                    : 'velas sin dato'}{' '}
                  en {series.gapRuns}{' '}
                  {series.gapRuns === 1 ? 'tramo' : 'tramos'}: se dejan vacías,
                  sin interpolar.
                </li>
              )}
              {series.afterCount > 0 ? (
                <li data-testid="context-after">
                  {series.afterCount}{' '}
                  {series.afterCount === 1
                    ? 'vela posterior observada'
                    : 'velas posteriores observadas'}{' '}
                  (atenuadas): solo las que la fuente tiene, sin cálculo de
                  resultado.
                </li>
              ) : (
                <li data-testid="context-after">
                  Sin velas posteriores observadas en la fuente.
                </li>
              )}
            </ul>
          </>
        )}
      {report && (
        <p className="obs-note inv-context__prov" data-testid="context-prov">
          Fuente: {report.candles.evidence.source} (
          {report.candles.evidence.origin ?? 'sin configurar'}) · velas
          oficiales ya guardadas, primera revisión conocida · leído a las{' '}
          {loaded.state === 'ready' ? utcClock(loaded.at) : ''}
        </p>
      )}
    </section>
  )
}
