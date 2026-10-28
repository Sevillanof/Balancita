import { useEffect, useState } from 'react'
import { utcDateTime } from '../../../shared/finance/format.ts'
import { failureReasons } from '../domain/run-failures.ts'
import { deriveStage } from '../domain/run-stage.ts'
import { horizonText } from '../domain/strategy-format.ts'
import { operationalLabel } from '../domain/strategy-labels.ts'
import {
  gateApi,
  type GateApi,
  type GateOverview,
  type GateRun,
} from '../infrastructure/gate-api.ts'
import {
  runVisualApi,
  type RunSummary,
  type RunVisualApi,
} from '../infrastructure/run-visual-api.ts'
import type {
  InventoryStrategy,
  StrategyApi,
  StrategyDetail,
} from '../infrastructure/strategy-api.ts'
import ModalFrame from './ModalFrame.tsx'
import {
  MODAL_ACTIONS,
  MODAL_BUTTON,
  MODAL_HINT,
  MODAL_NOTICE,
  MODAL_RUN,
  MODAL_VERDICT,
} from './modal-styles.ts'

type Props = {
  api: StrategyApi
  row: InventoryStrategy
  gate?: GateApi
  visual?: RunVisualApi
  onClose: () => void
}

const KIND_LABEL: Record<InventoryStrategy['kind'], string> = {
  rules: 'Reglas (JSON)',
  qwen_exit: 'Qwen decide las salidas',
  qwen_live: 'Qwen opera en vivo',
  model: 'Modelo',
}

const runName = (run: Pick<GateRun, 'id' | 'kind'>) =>
  `${run.kind === 'exam' ? 'Examen' : 'Práctica'} #${run.id}`

function windowOf(run: GateRun): string | null {
  const { from, to } = run.params ?? {}
  return from && to ? `${from} a ${to}` : null
}

/** Everything relevant about one strategy; for every test that did not pass, where it failed and why. */
export default function StrategyDetailsModal({
  api,
  row,
  gate = gateApi,
  visual = runVisualApi,
  onClose,
}: Props) {
  const [detail, setDetail] = useState<StrategyDetail | null>(null)
  const [overview, setOverview] = useState<GateOverview | null>(null)
  const [overviewError, setOverviewError] = useState<string | null>(null)
  const [summaries, setSummaries] = useState<Record<number, RunSummary | null>>(
    {},
  )

  useEffect(() => {
    if (row.kind !== 'rules') return
    let alive = true
    api.detail(row.id).then(
      (loaded) => alive && setDetail(loaded),
      () => undefined,
    )
    return () => {
      alive = false
    }
  }, [api, row.id, row.kind])

  useEffect(() => {
    let alive = true
    gate.overview(row.id).then(
      async (loaded) => {
        if (!alive) return
        setOverview(loaded)
        const done = loaded.runs.filter((run) => run.status === 'done')
        const pairs = await Promise.all(
          done.map(async (run) => {
            try {
              return [run.id, (await visual.summary(run.id)).summary] as const
            } catch {
              return [run.id, null] as const
            }
          }),
        )
        if (alive) setSummaries(Object.fromEntries(pairs))
      },
      (failure: unknown) => {
        if (alive)
          setOverviewError(
            failure instanceof Error ? failure.message : String(failure),
          )
      },
    )
    return () => {
      alive = false
    }
  }, [gate, visual, row.id])

  const stage = deriveStage(overview)
  const runs = [...(overview?.runs ?? [])].sort((a, b) => b.id - a.id)
  const horizon = horizonText(row.market.horizon_minutes)
  return (
    <ModalFrame label={`Detalles de ${row.name}`} onClose={onClose} wide>
      <h2>{row.name}</h2>
      <dl>
        <dt>Id</dt>
        <dd>{row.id}</dd>
        <dt>Tipo</dt>
        <dd>{KIND_LABEL[row.kind]}</dd>
        <dt>Versión</dt>
        <dd>
          {row.version}
          {detail && detail.versions.length > 1
            ? ` (${detail.versions.length} versiones guardadas)`
            : ''}
        </dd>
        <dt>Estado</dt>
        <dd>{operationalLabel(row.operational.state)}</dd>
        <dt>Etapa</dt>
        <dd>
          {stage.name} · {stage.reason}
        </dd>
        {detail?.created_at != null && (
          <>
            <dt>Creada</dt>
            <dd>{utcDateTime(detail.created_at)}</dd>
          </>
        )}
        {row.market.products != null && (
          <>
            <dt>Productos</dt>
            <dd>{row.market.products}</dd>
          </>
        )}
        {horizon && (
          <>
            <dt>Horizonte</dt>
            <dd>{horizon}</dd>
          </>
        )}
      </dl>
      {row.description && <p className={MODAL_HINT}>{row.description}</p>}
      {row.research.text && <p className={MODAL_HINT}>{row.research.text}</p>}

      <h3>Pruebas y examen</h3>
      {overviewError && (
        <p className={MODAL_NOTICE} data-tone="warn">
          {overviewError}
        </p>
      )}
      {overview && runs.length === 0 && (
        <p className={MODAL_HINT}>Todavía no tiene pruebas.</p>
      )}
      {runs.map((run) => {
        const summary = summaries[run.id] ?? null
        const reasons = summary ? failureReasons(summary) : []
        const verdict = summary?.verdict ?? run.verdict
        const range = windowOf(run)
        return (
          <div className={MODAL_RUN} key={run.id}>
            <p>
              <strong>{runName(run)}</strong>
              {range ? ` · ${range}` : ''}
              {run.same_version === false ? ' · de una versión anterior' : ''}
              {' · '}
              {run.status === 'done' && verdict ? (
                <span className={MODAL_VERDICT} data-verdict={verdict}>
                  {verdict}
                </span>
              ) : run.status === 'running' ? (
                'en curso'
              ) : run.status === 'cancelled' ? (
                'cancelada'
              ) : (
                'no terminó'
              )}
            </p>
            {run.status === 'failed' && run.error && <p>{run.error}</p>}
            {run.status === 'done' && verdict && verdict !== 'PASA' && (
              <>
                {reasons.length > 0 ? (
                  <ul aria-label={`En qué falló ${runName(run)}`}>
                    {reasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                ) : (
                  <p className={MODAL_HINT}>
                    {summary
                      ? 'No quedó guardado el detalle de en qué falló.'
                      : 'Esta prueba no guardó su detalle, así que no se puede ver en qué falló.'}
                  </p>
                )}
              </>
            )}
          </div>
        )
      })}

      {detail && (
        <>
          <h3>JSON de la estrategia</h3>
          <pre>{JSON.stringify(detail.spec, null, 2)}</pre>
        </>
      )}
      <div className={MODAL_ACTIONS}>
        <button type="button" className={MODAL_BUTTON} onClick={onClose}>
          Cerrar
        </button>
      </div>
    </ModalFrame>
  )
}
