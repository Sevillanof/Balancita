import { useEffect, useState } from 'react'
import { DataState } from '../../../shared/mission-control/index.ts'
import type {
  InventoryStrategy,
  StrategyApi,
} from '../infrastructure/strategy-api.ts'
import StrategyRunView from './StrategyRunView.tsx'
import './StrategiesPage.css'

type Props = {
  api: StrategyApi | null
  connectError: string | null
  reload: number
  /** Selected strategy, kept by the parent. */
  selectedId?: string | null
  onSelect?: (id: string) => void
}

/**
 * Estrategias: a plain list of strategy names on the left and, on the right,
 * the last test of the chosen one (stage, four figures, real candles).
 */
export default function StrategiesPage({
  api,
  connectError,
  reload,
  selectedId: keptId = null,
  onSelect,
}: Props) {
  const [rows, setRows] = useState<InventoryStrategy[] | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [localId, setLocalId] = useState<string | null>(null)

  useEffect(() => {
    if (!api?.inventory) return
    let active = true
    api.inventory().then(
      (inventory) => {
        if (!active) return
        setRows(inventory.strategies)
        setFailure(null)
      },
      (error: unknown) => {
        if (active)
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
  if (!rows) return <DataState kind="loading" title="Cargando estrategias…" />

  const chosen = keptId ?? localId
  const selected =
    rows.find((row) => row.id === chosen) ??
    rows.find((row) => row.kind === 'rules') ??
    rows[0] ??
    null
  const pick = (id: string) => {
    setLocalId(id)
    onSelect?.(id)
  }
  return (
    <section className="strategies" aria-label="Estrategias">
      <nav className="strategies__list" aria-label="Lista de estrategias">
        <ul>
          {rows.map((row) => (
            <li key={row.id} data-id={row.id}>
              <button
                type="button"
                aria-current={row.id === selected?.id ? 'true' : undefined}
                onClick={() => pick(row.id)}
              >
                {row.name}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <div className="strategies__detail" data-testid="strategy-pane">
        {selected && (
          <StrategyRunView
            key={selected.id}
            strategyId={selected.id}
            strategyName={selected.name}
            version={selected.version}
          />
        )}
      </div>
    </section>
  )
}
