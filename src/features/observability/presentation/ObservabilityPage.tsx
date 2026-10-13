import { useCallback, useState } from 'react'
import { DataState } from '../../../shared/mission-control/index.ts'
import {
  fetchActivity,
  fetchHealth,
  type ActivityWindow,
} from '../infrastructure/observability-api.ts'
import { useReport } from '../infrastructure/useReport.ts'
import ActivitySection from './ActivitySection.tsx'
import HealthSection from './HealthSection.tsx'
import './observability.css'

function ReadError({ what, message }: { what: string; message: string }) {
  return (
    <DataState
      kind="error"
      title={`No se pudo leer ${what}`}
      detail={`${message}. No se muestra ningún valor anterior como actual.`}
    />
  )
}

/**
 * Mission Control, observability: the six health components (B1) and the 3 h /
 * 24 h activity (B2) exactly as the gateway reports them, with their
 * limitations. It computes nothing: no status, no total, no age from the
 * browser clock. A failed read says so; it never falls back to «healthy».
 */
export default function ObservabilityPage() {
  const health = useReport(fetchHealth)

  const [window, setWindow] = useState<ActivityWindow>('3h')
  const [product, setProduct] = useState<string | null>(null)
  const [products, setProducts] = useState<readonly string[]>([])
  const loadActivity = useCallback(
    async (signal: AbortSignal) => {
      const report = await fetchActivity(window, product, signal)
      // The product list comes from an unfiltered read; a filtered one has one row.
      if (report.product === null && report.evaluations.state === 'ok')
        setProducts(report.evaluations.byProduct.map((p) => p.product))
      return report
    },
    [window, product],
  )
  const activity = useReport(loadActivity)

  // A report for another window or product than the one selected is not shown
  // as the answer to the new selection.
  const activityMatches =
    activity.data !== null &&
    activity.data.window === window &&
    activity.data.product === product

  return (
    <div className="obs-page">
      <header className="obs-page__heading">
        <p className="obs-page__eyebrow">Mission Control</p>
        <h1 className="obs-page__title">Observabilidad</h1>
        <p className="obs-page__lead">
          Estado y actividad leídos del gateway en solo lectura. Cada cifra
          viene del backend con su evidencia; lo que no se puede comprobar se
          muestra como «Sin datos».
        </p>
        <button
          type="button"
          className="obs-refresh"
          onClick={() => {
            health.reload()
            activity.reload()
          }}
        >
          Actualizar ahora
        </button>
      </header>

      <div className="obs-grid">
        {health.data ? (
          <HealthSection report={health.data} stale={health.error !== null} />
        ) : health.error ? (
          <ReadError what="la salud del sistema" message={health.error} />
        ) : (
          <DataState kind="loading" />
        )}

        <ActivitySection
          report={activityMatches ? activity.data : null}
          error={activity.error}
          window={window}
          onWindow={setWindow}
          product={product}
          products={products}
          onProduct={setProduct}
        />
      </div>
    </div>
  )
}
