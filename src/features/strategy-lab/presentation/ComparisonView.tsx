import { useEffect, useState } from 'react'
import { DataState, StatusPill } from '../../../shared/mission-control/index.ts'
import { count, horizonText, netBpPerOp } from '../domain/strategy-format.ts'
import {
  RETIRED_STATES,
  retiredReason,
  splitStrategies,
} from '../domain/comparison-groups.ts'
import type {
  Inventory,
  InventoryStrategy,
  StrategyApi,
} from '../infrastructure/strategy-api.ts'
import {
  activityAt,
  loadKronosActivity,
  type KronosActivity,
} from '../infrastructure/kronos-activity.ts'
import { marketText, validationDetail } from '../domain/inventory-text.ts'
import {
  FrozenBadge,
  OperationalBadge,
  ResearchBadge,
} from './StrategyStatusBadges.tsx'
import { ForwardResult } from './ForwardResult.tsx'
import { ForwardHealth } from './ForwardHealth.tsx'
import StrategyDetailView, { type LoadActivity } from './StrategyDetailView.tsx'
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
  activity = null,
  now,
}: {
  row: InventoryStrategy
  inventory: Inventory
  /** Only read for Kronos (`kind === 'model'`); null while unknown. */
  activity?: KronosActivity | null
  now: number
  onOpen: () => void
}) {
  const backtest = row.research.backtest
  const net = netBpPerOp(backtest?.mean_net_bp)
  const detail = validationDetail(row, inventory)
  const start = forwardText(row)
  const verified = row.kind === 'model' && activity?.verified ? activity : null
  return (
    <article
      className="comparison__card"
      data-testid="experiment-card"
      data-id={row.id}
    >
      <header>
        <span className="comparison__kind">EXP · {KIND_LABELS[row.kind]}</span>
        {verified ? (
          <span data-testid="kronos-verified">
            <StatusPill tone="ok">Actividad reciente registrada</StatusPill>
          </span>
        ) : (
          <OperationalBadge
            state={row.operational.state}
            basis={row.operational.basis}
            sinceMs={row.operational.since_ms}
            reason={row.operational.reason}
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

      <ForwardResult row={row} now={now} />
      {start && <small className="comparison__start">{start}</small>}

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
              <small>
                Es un registro del resumen: no prueba que el proceso siga
                corriendo.
              </small>
            </>
          ) : (
            <em>Estado no verificado</em>
          )}
        </section>
      )}

      <section className="comparison__block comparison__secondary">
        <h4>Backtest (neto de costes) · histórico, no decide</h4>
        {net && backtest ? (
          <>
            <strong>{net}</strong>
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

      <section className="comparison__block comparison__secondary">
        <h4>Modelo</h4>
        <p>{marketText(row)}</p>
      </section>

      <section className="comparison__block comparison__verdict">
        <h4>Veredicto según la evidencia</h4>
        <p>{detail.line}</p>
        {detail.extra && <p>{detail.extra}</p>}
      </section>

      <button
        type="button"
        className="comparison__open"
        aria-label={
          row.kind === 'model'
            ? 'Abrir Kronos en el Laboratorio'
            : row.kind === 'carry'
              ? `Ver contador de ${row.name}`
              : `Detalle de ${row.name}`
        }
        disabled={row.kind === 'qwen_exit'}
        title={
          row.kind === 'qwen_exit'
            ? 'Sin detalle: los resultados de C31 son un archivo local'
            : undefined
        }
        onClick={onOpen}
      >
        {row.kind === 'model'
          ? 'Abrir Kronos en el Laboratorio →'
          : row.kind === 'carry'
            ? 'Ver contador →'
            : 'Detalle →'}
      </button>
    </article>
  )
}

/** One row of the list on the left; retired ones keep their reason visible. */
function ListItem({
  row,
  selected,
  testId,
  onSelect,
}: {
  row: InventoryStrategy
  selected: boolean
  testId: string
  onSelect: () => void
}) {
  const stopped = RETIRED_STATES.includes(row.operational.state)
  return (
    <li data-testid={testId} data-id={row.id}>
      <button
        type="button"
        className={selected ? 'is-selected' : undefined}
        aria-current={selected ? 'true' : undefined}
        aria-label={`Ver ${row.name}`}
        onClick={onSelect}
      >
        <b>{row.name}</b> <small>v{row.version}</small>
        <OperationalBadge
          state={row.operational.state}
          basis={row.operational.basis}
          sinceMs={row.operational.since_ms}
          reason={row.operational.reason}
        />
        {stopped && (
          <small className="comparison__why">
            Motivo: {retiredReason(row.operational.reason) ?? 'No disponible'}
            {row.operational.since_ms != null &&
              ` · desde ${utcDay(row.operational.since_ms)}`}
          </small>
        )}
      </button>
    </li>
  )
}

type Props = {
  api: StrategyApi | null
  connectError: string | null
  reload: number
  /** Opens a strategy in the laboratory. */
  onOpen: (row: InventoryStrategy) => void
  /** «Nueva estrategia»: opens the laboratory. */
  onNew: () => void
  /** Selected strategy, kept by the parent so it survives a visit to the laboratory. */
  selectedId?: string | null
  onSelect?: (id: string) => void
  loadActivity?: () => Promise<KronosActivity>
  /** Activity loader of the detail pane (tests). */
  loadDetailActivity?: LoadActivity
}

const ACTIVITY_TICK_MS = 30_000
const ACTIVITY_REREAD_MS = 5 * 60_000

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
  onNew,
  selectedId: keptId = null,
  onSelect,
  loadActivity = defaultLoadActivity,
  loadDetailActivity,
}: Props) {
  const [inventory, setInventory] = useState<Inventory | null>(null)
  const [read, setRead] = useState<KronosActivity | null>(null)
  const [now, setNow] = useState(() => Date.now())

  // Re-read periodically; a failed read never keeps the previous "reciente".
  useEffect(() => {
    let active = true
    const run = () =>
      loadActivity().then(
        (loaded) => {
          if (!active) return
          setNow(Date.now())
          setRead(loaded)
        },
        () => active && setRead({ verified: false, reason: 'error' }),
      )
    void run()
    const reread = setInterval(() => void run(), ACTIVITY_REREAD_MS)
    return () => {
      active = false
      clearInterval(reread)
    }
  }, [loadActivity, reload])

  // Freshness is evaluated against the clock on every tick and render.
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), ACTIVITY_TICK_MS)
    return () => clearInterval(tick)
  }, [])
  const activity = activityAt(read, now)
  const [failure, setFailure] = useState<string | null>(null)
  const [localId, setLocalId] = useState<string | null>(null)
  const selectedId = keptId ?? localId
  const setSelectedId = (id: string) => {
    setLocalId(id)
    onSelect?.(id)
  }

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

  const { active: running, retired } = splitStrategies(inventory)
  const cost = inventory.cost_model
  const selected =
    inventory.strategies.find((row) => row.id === selectedId) ??
    running.find((row) => row.kind === 'rules') ??
    running[0] ??
    retired[0] ??
    null
  return (
    <section className="comparison" aria-label="Estrategias">
      <header className="comparison__head">
        <div>
          <p className="comparison__eyebrow">Estrategias</p>
          <h2>Un libro paper por estrategia</h2>
        </div>
        <button type="button" className="comparison__new" onClick={onNew}>
          Nueva estrategia
        </button>
      </header>

      <div className="comparison__banner" role="note">
        <b>Libros segregados:</b> cada estrategia tiene su propio libro paper (
        {inventory.notional_usd} USD por operación
        {cost ? `, costes ${cost.version}` : ''}). Los resultados{' '}
        <b className="is-down">no se suman</b> ni se comparan con métricas de
        otra unidad o metodología. No hay cartera consolidada.
      </div>

      <ForwardHealth health={inventory.forward_health} now={now} />

      <div className="comparison__split">
        <nav className="comparison__list" aria-label="Lista de estrategias">
          <h3 className="comparison__group">
            Activas · <span data-testid="running-count">{running.length}</span>
          </h3>
          <ul>
            {running.map((row) => (
              <ListItem
                key={row.id}
                row={row}
                selected={row.id === selected?.id}
                testId="strategy-list-item"
                onSelect={() => setSelectedId(row.id)}
              />
            ))}
          </ul>
          <h3 className="comparison__group" data-testid="retired">
            Retiradas y apagadas ·{' '}
            <span data-testid="stopped-count">{retired.length}</span>
          </h3>
          <ul>
            {retired.map((row) => (
              <ListItem
                key={row.id}
                row={row}
                selected={row.id === selected?.id}
                testId="retired-row"
                onSelect={() => setSelectedId(row.id)}
              />
            ))}
          </ul>
        </nav>

        <div className="comparison__detail" data-testid="strategy-pane">
          {selected &&
            (selected.kind === 'rules' && typeof api.detail === 'function' ? (
              <>
                <ForwardResult row={selected} now={now} />
                <StrategyDetailView
                  key={selected.id}
                  api={api}
                  row={selected}
                  inventory={inventory}
                  loadActivity={loadDetailActivity}
                  onOpenLab={() => onOpen(selected)}
                />
              </>
            ) : selected ? (
              <ExperimentCard
                row={selected}
                inventory={inventory}
                onOpen={() => onOpen(selected)}
                activity={activity}
                now={now}
              />
            ) : null)}
        </div>
      </div>

      <details className="comparison__panel" data-testid="measure-table">
        <summary>Qué mide cada estrategia</summary>
        <table>
          <thead>
            <tr>
              <th>Estrategia</th>
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
      </details>
    </section>
  )
}
