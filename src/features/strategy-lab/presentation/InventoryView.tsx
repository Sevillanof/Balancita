import { Fragment, useEffect, useState } from 'react'
import { amount } from '../../../shared/finance/format.ts'
import { DataState } from '../../../shared/mission-control/index.ts'
import {
  count,
  horizonText,
  netBpPerOp,
  netUsd,
} from '../domain/strategy-format.ts'
import type {
  Inventory,
  InventoryStrategy,
  StrategyApi,
} from '../infrastructure/strategy-api.ts'
import {
  FILTERS,
  filterCount,
  matchesFilter,
  type InventoryFilter,
} from '../domain/inventory-filter.ts'
import {
  FrozenBadge,
  OperationalBadge,
  ResearchBadge,
} from './StrategyStatusBadges.tsx'

function marketText(row: InventoryStrategy) {
  const parts: string[] = []
  if (row.market.products)
    parts.push(
      row.kind === 'carry'
        ? `${row.market.products} perpetuos PF_ + contado`
        : `${row.market.products} perpetuos PF_`,
    )
  if (row.market.exit_by === 'qwen') parts.push('Qwen decide la salida')
  else if (row.market.horizon_minutes != null)
    parts.push(`horizonte ${horizonText(row.market.horizon_minutes)}`)
  return parts.length > 0 ? parts.join(' · ') : 'No disponible'
}

function validationDetail(row: InventoryStrategy, inventory: Inventory) {
  const backtest = row.research.backtest
  if (backtest) {
    const t =
      backtest.t_stat == null ? 'No disponible' : amount(backtest.t_stat)
    const tests = backtest.selection_trials
    return {
      line: `t = ${t} · prob. deflactada ${
        backtest.deflated_probability == null
          ? 'No disponible'
          : amount(backtest.deflated_probability)
      } · tramos positivos ${backtest.folds_positive ?? '—'}/${backtest.folds_judged ?? '—'}`,
      extra:
        tests == null
          ? null
          : tests > 1
            ? `Elegida entre ${count(tests)} configuraciones`
            : 'Elegida entre 1 configuración',
    }
  }
  if (row.kind === 'carry')
    return { line: row.research.text ?? 'Estado no verificado', extra: null }
  if (row.kind === 'qwen_exit')
    return {
      line: `Qwen decide la salida; se juzga con ${count(inventory.forward_min_trades)} operaciones forward.`,
      extra: null,
    }
  if (row.kind === 'model')
    return { line: 'Resultados en archivo local; sin endpoint.', extra: null }
  if (row.no_backtest)
    return {
      line: 'Sin backtest por diseño: solo cuentan las operaciones posteriores al inicio.',
      extra: null,
    }
  return { line: 'Sin medición comparable para este spec.', extra: null }
}

/** One strategy row of the inventory. Exported so later views reuse the table. */
export function InventoryRow({
  row,
  inventory,
  auditing,
  onToggleAudit,
  onOpen,
}: {
  row: InventoryStrategy
  inventory: Inventory
  auditing: boolean
  onToggleAudit: () => void
  onOpen: () => void
}) {
  const backtest = row.research.backtest
  const closed = row.operational.state === 'closed'
  const net = netBpPerOp(backtest?.mean_net_bp)
  const detail = validationDetail(row, inventory)
  return (
    <tr
      className={closed ? 'inventory__row is-closed' : 'inventory__row'}
      data-testid="inventory-row"
      data-id={row.id}
    >
      <td>
        <div className="inventory__name">
          {row.name} <small>v{row.version}</small>
        </div>
        <div
          className="inventory__sub inventory__sub--clamp"
          title={row.description}
        >
          {row.description}
        </div>
      </td>
      <td>
        <div className="inventory__badges">
          <OperationalBadge
            state={row.operational.state}
            basis={row.operational.basis}
          />
          {row.frozen && <FrozenBadge />}
        </div>
        <div className="inventory__sub">{marketText(row)}</div>
      </td>
      <td className="inventory__num">
        {backtest ? (
          <>
            <strong>{count(backtest.trades)}</strong>
            <span>ops de backtest</span>
          </>
        ) : (
          <em>Sin backtest</em>
        )}
        <span title="Operaciones del forward: la fuente (B5) todavía no existe">
          forward: B5
        </span>
      </td>
      <td className="inventory__num">
        {net ? (
          <>
            <strong
              className={
                (backtest?.mean_net_bp ?? 0) >= 0 ? 'is-up' : 'is-down'
              }
            >
              {net}
            </strong>
            <span>{netUsd(backtest?.pnl_usd)} · backtest</span>
          </>
        ) : (
          <em>No disponible</em>
        )}
        <span title="Resultado del forward: la fuente (B5) todavía no existe">
          paper: B5
        </span>
      </td>
      <td>
        <ResearchBadge state={row.research.state} />
        <div className="inventory__sub">{detail.line}</div>
        {detail.extra && <div className="inventory__sub">{detail.extra}</div>}
      </td>
      <td className="inventory__action">
        {closed ? (
          <button
            type="button"
            aria-expanded={auditing}
            aria-label={`Auditar ${row.name}`}
            onClick={onToggleAudit}
          >
            Auditar →
          </button>
        ) : (
          <button
            type="button"
            aria-label={`Detalle de ${row.name}`}
            disabled={row.kind === 'qwen_exit'}
            title={
              row.kind === 'qwen_exit'
                ? 'Sin detalle: los resultados de C31 son un archivo local (B5)'
                : undefined
            }
            onClick={onOpen}
          >
            {row.kind === 'carry' ? 'Ver contador →' : 'Detalle →'}
          </button>
        )}
      </td>
    </tr>
  )
}

/** Audit of a closed strategy: the ranges and the source of its verdict, read only. */
export function AuditRow({ row }: { row: InventoryStrategy }) {
  const backtest = row.research.backtest
  return (
    <tr className="inventory__audit" data-testid="inventory-audit">
      <td colSpan={6}>
        <div className="inventory__audit-body">
          <p>
            <b>{row.name}</b> · {row.id} · spec{' '}
            <code>{row.spec_hash?.slice(0, 12) ?? 'No disponible'}</code> ·
            motivo del cierre:{' '}
            <code>{row.operational.reason ?? 'No disponible'}</code>
          </p>
          {row.note && <p>{row.note}</p>}
          {backtest && Object.keys(backtest.ranges).length > 0 ? (
            <table>
              <thead>
                <tr>
                  <th>Rango</th>
                  <th>Operaciones</th>
                  <th>Neto medio</th>
                  <th>t</th>
                  <th>Tramos positivos</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(backtest.ranges).map(([name, range]) => (
                  <tr key={name}>
                    <td>
                      {name === 'previous'
                        ? 'Previo'
                        : name === 'recent'
                          ? 'Reciente'
                          : name}
                    </td>
                    <td>{count(range.trades)}</td>
                    <td>{netBpPerOp(range.mean_net_bp) ?? 'No disponible'}</td>
                    <td>
                      {range.t_stat == null
                        ? 'No disponible'
                        : amount(range.t_stat)}
                    </td>
                    <td>
                      {range.folds_positive ?? '—'}/{range.folds_judged ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p>No disponible: sin medición por rango para este spec.</p>
          )}
        </div>
      </td>
    </tr>
  )
}

function rangeDays(inventory: Inventory) {
  const ranges = Object.values(inventory.period?.ranges ?? {})
  const first = ranges[0]
  return first
    ? Math.round(
        (first.last_bucket_ms - first.first_bucket_ms + 60_000) / 86_400_000,
      )
    : null
}

type Props = {
  api: StrategyApi | null
  connectError: string | null
  reload: number
  onOpen: (row: InventoryStrategy) => void
  /** The loaded inventory, for the header figures of the page. */
  onLoaded?: (inventory: Inventory | null) => void
}

/** Default view of Estrategias: who is active, frozen, closed or under study, and what the evidence says. */
export default function InventoryView({
  api,
  connectError,
  reload,
  onOpen,
  onLoaded,
}: Props) {
  const [inventory, setInventory] = useState<Inventory | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [filter, setFilter] = useState<InventoryFilter>('all')
  const [audits, setAudits] = useState<ReadonlySet<string>>(new Set())

  useEffect(() => {
    if (!api?.inventory) return
    let active = true
    api.inventory().then(
      (loaded) => {
        if (!active) return
        setInventory(loaded)
        setFailure(null)
        onLoaded?.(loaded)
      },
      (error: unknown) => {
        if (!active) return
        setFailure(error instanceof Error ? error.message : String(error))
        onLoaded?.(null)
      },
    )
    return () => {
      active = false
    }
  }, [api, reload, onLoaded])

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
        detail={`${failure}`}
      />
    )
  if (!inventory)
    return <DataState kind="loading" title="Cargando el inventario…" />

  const rows = inventory.strategies.filter((row) => matchesFilter(row, filter))
  const days = rangeDays(inventory)
  const thresholds = inventory.thresholds
  const cost = inventory.cost_model

  return (
    <section className="inventory" aria-label="Inventario de modelos">
      <header className="inventory__head">
        <div>
          <p className="inventory__eyebrow">
            Directorio cuantitativo ·{' '}
            <span className="is-up">
              {inventory.counts.active} activas en el registro
            </span>
          </p>
          <h2>Inventario de modelos y calificación estadística</h2>
        </div>
        <div className="inventory__chips">
          {thresholds.t_reliable != null && (
            <span>
              Fiable: t &gt; {amount(thresholds.t_reliable)} y ≥{' '}
              {count(thresholds.reliable_trades)} ops
            </span>
          )}
          {thresholds.t_tentative != null && (
            <span>Tentativa: t &gt; {amount(thresholds.t_tentative)}</span>
          )}
        </div>
      </header>

      <div
        className="inventory__filters"
        role="group"
        aria-label="Filtrar estrategias"
      >
        {FILTERS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            aria-pressed={filter === id}
            onClick={() => setFilter(id)}
          >
            {label} <b>{filterCount(inventory, id)}</b>
          </button>
        ))}
      </div>

      <div className="inventory__table-wrap">
        <table className="inventory__table">
          <thead>
            <tr>
              <th>Nombre y versión</th>
              <th>Estado operativo / mercado</th>
              <th className="inventory__num">Muestra</th>
              <th className="inventory__num">Resultado neto</th>
              <th>Validación estadística</th>
              <th className="inventory__action">Acción</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={6}>
                  <DataState
                    kind="empty"
                    detail="Ninguna estrategia cumple este filtro."
                  />
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <Fragment key={row.id}>
                <InventoryRow
                  row={row}
                  inventory={inventory}
                  auditing={audits.has(row.id)}
                  onToggleAudit={() =>
                    setAudits((current) => {
                      const next = new Set(current)
                      if (!next.delete(row.id)) next.add(row.id)
                      return next
                    })
                  }
                  onOpen={() => onOpen(row)}
                />
                {audits.has(row.id) && <AuditRow row={row} />}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <div className="inventory__notes">
        <article>
          <h3>Regla contra el sobreajuste</h3>
          <p>
            Una estrategia no se califica por su número de operaciones: se exige
            t &gt; {amount(thresholds.t_reliable ?? 0)} con al menos{' '}
            {count(thresholds.reliable_trades)}, y se descuenta por las
            configuraciones probadas (probabilidad deflactada).
          </p>
        </article>
        <article>
          <h3>Un solo modelo de costes</h3>
          <p>
            {cost ? (
              <>
                Todas las cifras son netas de comisiones, spread, slippage y
                funding según <code>{cost.version}</code> (hash{' '}
                {cost.hash.slice(0, 8)}).
              </>
            ) : (
              'Modelo de costes: No disponible.'
            )}
          </p>
        </article>
        <article>
          <h3>Backtest y forward, separados</h3>
          <p>
            Las cifras de esta tabla son de backtest
            {days ? ` en dos rangos de ${days} días` : ''}. Los resultados del
            forward paper se mostrarán cuando B5 los exponga; hasta entonces
            figuran «forward: B5».
          </p>
        </article>
      </div>
    </section>
  )
}
