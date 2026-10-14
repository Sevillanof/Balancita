import { useEffect, useState } from 'react'
import { DataState, StatusPill } from '../../../shared/mission-control/index.ts'
import { count, horizonText, netBpPerOp } from '../domain/strategy-format.ts'
import { splitExperiments } from '../domain/comparison-groups.ts'
import type {
  Inventory,
  InventoryStrategy,
  StrategyApi,
} from '../infrastructure/strategy-api.ts'
import {
  loadKronosActivity,
  type KronosActivity,
} from '../infrastructure/kronos-activity.ts'
import { marketText, validationDetail } from '../domain/inventory-text.ts'
import {
  FrozenBadge,
  OperationalBadge,
  ResearchBadge,
} from './StrategyStatusBadges.tsx'
import './ComparisonView.css'

const KIND_LABELS: Record<InventoryStrategy['kind'], string> = {
  rules: 'Reglas',
  qwen_exit: 'Qwen decide la salida',
  model: 'Modelo',
  carry: 'Contador aparte',
}

const EXIT_LABELS: Record<string, string> = {
  rules: 'Regla',
  qwen: 'Qwen',
  time: 'Horizonte fijo',
}

function utcDay(ms: number) {
  return new Date(ms).toISOString().slice(0, 10)
}

function utcTime(ms: number) {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

function forwardText(row: InventoryStrategy) {
  if (row.forward.start_ms != null)
    return `Registrada desde ${utcDay(row.forward.start_ms)} (UTC)`
  return null
}

/** One experiment, its own book: nothing here is added to another card. */
export function ExperimentCard({
  row,
  inventory,
  onOpen,
  onInventory,
  activity = null,
}: {
  row: InventoryStrategy
  inventory: Inventory
  /** Only read for Kronos (`kind === 'model'`); null while unknown. */
  activity?: KronosActivity | null
  onOpen: () => void
  onInventory: () => void
}) {
  const backtest = row.research.backtest
  const net = netBpPerOp(backtest?.mean_net_bp)
  const detail = validationDetail(row, inventory)
  const closed = row.operational.state === 'closed'
  const start = forwardText(row)
  const verified = row.kind === 'model' && activity?.verified ? activity : null
  return (
    <article
      className={closed ? 'comparison__card is-closed' : 'comparison__card'}
      data-testid="experiment-card"
      data-id={row.id}
    >
      <header>
        <span className="comparison__kind">EXP · {KIND_LABELS[row.kind]}</span>
        {verified ? (
          <span data-testid="kronos-verified">
            <StatusPill tone="ok">Actividad verificada</StatusPill>
          </span>
        ) : (
          <OperationalBadge
            state={row.operational.state}
            basis={row.operational.basis}
          />
        )}
      </header>
      <h3>
        {row.name} <small>v{row.version}</small>
      </h3>
      <p className="comparison__desc" title={row.description}>
        {row.description}
      </p>
      <div className="comparison__badges">
        <ResearchBadge state={row.research.state} />
        {row.frozen && <FrozenBadge />}
      </div>

      <section className="comparison__block">
        <h4>Modelo</h4>
        <p>{marketText(row)}</p>
      </section>

      {row.kind === 'model' && (
        <section className="comparison__block" data-testid="kronos-activity">
          <h4>Actividad (solo lectura)</h4>
          {verified ? (
            <>
              <strong>
                {verified.trades == null
                  ? 'No disponible'
                  : count(verified.trades)}{' '}
                operaciones ·{' '}
                {verified.decisions == null
                  ? 'No disponible'
                  : count(verified.decisions)}{' '}
                decisiones
              </strong>
              <small>Resumen del ciclo de {utcTime(verified.updated_ms)}</small>
            </>
          ) : (
            <em>Estado no verificado</em>
          )}
        </section>
      )}

      <section className="comparison__block">
        <h4>Backtest (neto de costes)</h4>
        {net && backtest ? (
          <>
            <strong
              className={(backtest.mean_net_bp ?? 0) >= 0 ? 'is-up' : 'is-down'}
            >
              {net}
            </strong>
            <small>
              {count(backtest.trades)} ops
              {backtest.t_stat != null ? ` · t = ${backtest.t_stat}` : ''}
              {backtest.folds_judged != null
                ? ` · tramos ${backtest.folds_positive ?? '—'}/${backtest.folds_judged}`
                : ''}
            </small>
          </>
        ) : (
          <em>
            {row.no_backtest
              ? 'Sin backtest por diseño'
              : 'Sin backtest comparable'}
          </em>
        )}
      </section>

      <section className="comparison__block">
        <h4>Forward paper</h4>
        <em>No disponible (B5)</em>
        {start && <small>{start}</small>}
      </section>

      <section className="comparison__block comparison__verdict">
        <h4>Veredicto según la evidencia</h4>
        <p>{detail.line}</p>
        {detail.extra && <p>{detail.extra}</p>}
      </section>

      {closed || row.kind === 'qwen_exit' ? (
        <button type="button" onClick={onInventory}>
          Ver en inventario
        </button>
      ) : (
        <button
          type="button"
          aria-label={`Detalle de ${row.name}`}
          onClick={onOpen}
        >
          {row.kind === 'carry' ? 'Ver contador →' : 'Detalle →'}
        </button>
      )}
    </article>
  )
}

type Props = {
  api: StrategyApi | null
  connectError: string | null
  reload: number
  onOpen: (row: InventoryStrategy) => void
  onBack: () => void
  loadActivity?: () => Promise<KronosActivity>
}

const defaultLoadActivity = () => loadKronosActivity()

/**
 * Experiment comparison: one independent book per experiment, side by side.
 * No consolidated portfolio, no sums and no ranking across experiments.
 */
export default function ComparisonView({
  api,
  connectError,
  reload,
  onOpen,
  onBack,
  loadActivity = defaultLoadActivity,
}: Props) {
  const [inventory, setInventory] = useState<Inventory | null>(null)
  const [activity, setActivity] = useState<KronosActivity | null>(null)

  useEffect(() => {
    let active = true
    loadActivity().then(
      (loaded) => active && setActivity(loaded),
      () => active && setActivity({ verified: false, reason: 'error' }),
    )
    return () => {
      active = false
    }
  }, [loadActivity, reload])
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    if (!api?.inventory) return
    let active = true
    api.inventory().then(
      (loaded) => {
        if (!active) return
        setInventory(loaded)
        setFailure(null)
      },
      (error: unknown) => {
        if (!active) return
        setFailure(error instanceof Error ? error.message : String(error))
      },
    )
    return () => {
      active = false
    }
  }, [api, reload])

  if (connectError)
    return (
      <DataState
        kind="error"
        title="No se pudo leer el inventario"
        detail={`${connectError} No se muestran datos de ejemplo.`}
      />
    )
  if (!api)
    return (
      <DataState
        kind="loading"
        title="Conectando con el registro de estrategias…"
      />
    )
  if (!api.inventory)
    return (
      <DataState
        kind="unavailable"
        detail="Este origen de datos no ofrece el inventario de estrategias."
      />
    )
  if (failure)
    return (
      <DataState
        kind="error"
        title="No se pudo leer el inventario"
        detail={failure}
      />
    )
  if (!inventory)
    return <DataState kind="loading" title="Cargando la comparación…" />

  const { running, stopped } = splitExperiments(inventory)
  const renderCard = (row: InventoryStrategy) => (
    <ExperimentCard
      key={row.id}
      row={row}
      inventory={inventory}
      onOpen={() => onOpen(row)}
      onInventory={onBack}
      activity={activity}
    />
  )
  return (
    <section className="comparison" aria-label="Comparación de experimentos">
      <header className="comparison__head">
        <div>
          <p className="comparison__eyebrow">
            Estrategias · <b>Comparación de experimentos</b>
          </p>
          <h2>Un libro paper por experimento</h2>
        </div>
        <button type="button" onClick={onBack}>
          ← Volver al inventario
        </button>
      </header>

      <div className="comparison__banner" role="note">
        <b>Libros segregados:</b> cada experimento tiene su propio libro paper (
        {inventory.notional_usd} USD por operación). Los resultados{' '}
        <b className="is-down">no se suman</b> ni se comparan con métricas de
        otra unidad o metodología. No hay cartera consolidada.
      </div>

      <h3 className="comparison__group">
        Experimentos · <span data-testid="running-count">{running.length}</span>
      </h3>
      <div className="comparison__grid">{running.map(renderCard)}</div>

      <h3 className="comparison__group">
        Cerrados y contador aparte ·{' '}
        <span data-testid="stopped-count">{stopped.length}</span>
      </h3>
      <div className="comparison__grid">{stopped.map(renderCard)}</div>

      <div className="comparison__lower">
        <article className="comparison__panel">
          <h3>Equity por experimento</h3>
          <p>
            <b>No disponible.</b> Solo se mostrarán series reales por
            experimento cuando exista el endpoint del forward (B5). Nunca una
            curva consolidada.
          </p>
        </article>
        <article className="comparison__panel">
          <h3>
            Qué mide cada experimento <small>por qué no se suman</small>
          </h3>
          <table>
            <thead>
              <tr>
                <th>Experimento</th>
                <th>Quién decide la salida</th>
                <th>Horizonte</th>
                <th>Unidad del resultado</th>
              </tr>
            </thead>
            <tbody>
              {running.map((row) => (
                <tr key={row.id}>
                  <td>{row.name}</td>
                  <td>
                    {row.market.exit_by
                      ? EXIT_LABELS[row.market.exit_by]
                      : 'No disponible'}
                  </td>
                  <td>
                    {horizonText(row.market.horizon_minutes) ?? 'No disponible'}
                  </td>
                  <td>
                    {netBpPerOp(row.research.backtest?.mean_net_bp)
                      ? 'pb por operación (neto)'
                      : 'No disponible'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            Resultados del forward, concurrencia cruzada y pérdida
            correlacionada: no disponibles (B5).
          </p>
        </article>
      </div>
    </section>
  )
}
