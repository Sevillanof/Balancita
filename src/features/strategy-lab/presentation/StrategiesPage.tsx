import { useEffect, useState } from 'react'
import { DataState } from '../../../shared/mission-control/index.ts'
import type { GateApi } from '../infrastructure/gate-api.ts'
import type { RunVisualApi } from '../infrastructure/run-visual-api.ts'
import type {
  InventoryStrategy,
  PurgeStatus,
  StrategyApi,
} from '../infrastructure/strategy-api.ts'
import { operationalLabel } from '../domain/strategy-labels.ts'
import DeleteStrategyDialog from './DeleteStrategyDialog.tsx'
import ActivationDialog from './ActivationDialog.tsx'
import PurgeNotice from './PurgeNotice.tsx'
import { groupStrategies } from '../domain/strategy-order.ts'
import { signedAmount } from '../domain/strategy-format.ts'
import { useStandings } from './use-standings.ts'
import StrategyDetailsModal from './StrategyDetailsModal.tsx'
import { describeFailure } from './describe-failure.ts'
import StrategyEditorModal from './StrategyEditorModal.tsx'
import StrategyRunView from './StrategyRunView.tsx'
import './StrategiesPage.css'

type Props = {
  api: StrategyApi | null
  connectError: string | null
  reload: number
  /** Selected strategy, kept by the parent. */
  selectedId?: string | null
  onSelect?: (id: string) => void
  /** Where the stage and the net per trade of each strategy are read (default: the real gate). */
  gate?: GateApi
  visual?: RunVisualApi
}

type Modal =
  | { kind: 'create' }
  | { kind: 'modify'; id: string }
  | { kind: 'details'; id: string }
  | { kind: 'delete'; id: string }
  | { kind: 'activate'; id: string; passed: boolean | null }

/**
 * Only what exists: strategies retired from the old engine (`closed`) and shipped specs the registry
 * does not know (`basis: none`) come back in the inventory but cannot be opened, edited or deleted.
 */
const exists = (row: InventoryStrategy) =>
  row.operational.state !== 'closed' &&
  !(row.kind === 'rules' && row.operational.basis === 'none')

/** Qwen and Kronos act in the paper from code: they are tested but never edited or deleted here. */
const editable = (row: InventoryStrategy) => row.kind === 'rules'

const operating = (row: InventoryStrategy) =>
  row.operational.state === 'active' || row.operational.state === 'shadow'

/**
 * Estrategias: a plain list of strategy names on the left (each with a menu:
 * detalles, modificar, borrar) and, on the right, the last test of the chosen
 * one (stage, four figures, real candles). Create / modify / details / delete
 * open as modals on this same screen.
 */
export default function StrategiesPage({
  api,
  connectError,
  reload,
  selectedId: keptId = null,
  onSelect,
  gate,
  visual,
}: Props) {
  const [rows, setRows] = useState<InventoryStrategy[] | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [localId, setLocalId] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [menuId, setMenuId] = useState<string | null>(null)
  const [modal, setModal] = useState<Modal | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const standings = useStandings(rows, gate, visual)
  const [purge, setPurge] = useState<{
    name: string
    status: PurgeStatus
  } | null>(null)

  useEffect(() => {
    if (!api?.inventory) return
    let active = true
    api.inventory().then(
      (inventory) => {
        if (!active) return
        setRows(inventory.strategies.filter(exists))
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
  }, [api, reload, refresh])

  useEffect(() => {
    if (menuId === null) return
    const close = () => setMenuId(null)
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menuId])

  useEffect(() => {
    if (!api || !purge || purge.status.state === 'done') return
    const id = purge.status.purge_id
    if (!id) return
    const timer = setInterval(() => {
      void api
        .purgeStatus(id)
        .then((status) =>
          setPurge((current) => (current ? { ...current, status } : current)),
        )
        .catch(() => undefined)
    }, 2000)
    return () => clearInterval(timer)
  }, [api, purge])

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
  const rowOf = (id: string) => rows.find((row) => row.id === id) ?? null
  const done = (id: string, text: string) => {
    setModal(null)
    setProblem(null)
    setNotice(text)
    pick(id)
    setRefresh((value) => value + 1)
  }

  const startActivation = async (row: InventoryStrategy) => {
    setModal({ kind: 'activate', id: row.id, passed: null })
    const passed = api.gatePassed
      ? await api.gatePassed(row.id, row.version).catch(() => false)
      : false
    setModal({ kind: 'activate', id: row.id, passed })
  }
  const switchOff = async (row: InventoryStrategy) => {
    try {
      const detail = await api.detail(row.id)
      await api.setState(
        row.id,
        detail.active_version ?? detail.version,
        'retired',
      )
      done(row.id, `«${row.name}» quedó apagada.`)
    } catch (error) {
      setProblem(describeFailure(error))
    }
  }
  const activate = async (row: InventoryStrategy) => {
    try {
      await api.setState(row.id, row.version, 'active', true)
      done(row.id, `«${row.name}» quedó activa en el paper.`)
    } catch (error) {
      setModal(null)
      setProblem(describeFailure(error))
    }
  }

  const open = modal && modal.kind !== 'create' ? rowOf(modal.id) : null
  return (
    <section className="strategies" aria-label="Estrategias">
      <nav className="strategies__list" aria-label="Lista de estrategias">
        <p className="strategies__heading">Estrategias</p>
        {groupStrategies(rows, standings).map((group) => (
          <div key={group.key} className="strategies__group">
            {group.title && <p className="strategies__stage">{group.title}</p>}
            <ul>
              {group.rows.map((row) => (
                <li key={row.id} data-id={row.id}>
                  <button
                    type="button"
                    className="strategies__pick"
                    aria-current={row.id === selected?.id ? 'true' : undefined}
                    onClick={() => pick(row.id)}
                  >
                    <span>{row.name}</span>
                    {standings.get(row.id)?.meanBp != null && (
                      <small
                        className="strategies__net"
                        title="Neto por operación del último test"
                      >
                        {signedAmount(standings.get(row.id)?.meanBp ?? null, 1)}{' '}
                        pb
                      </small>
                    )}
                    <i
                      className="strategies__dot"
                      data-state={row.operational.state}
                      title={operationalLabel(row.operational.state)}
                      aria-hidden="true"
                    />
                  </button>
                  <button
                    type="button"
                    className="strategies__more"
                    aria-label={`Opciones de ${row.name}`}
                    aria-haspopup="menu"
                    aria-expanded={menuId === row.id}
                    onClick={(event) => {
                      event.stopPropagation()
                      setMenuId(menuId === row.id ? null : row.id)
                    }}
                  >
                    ⋮
                  </button>
                  {menuId === row.id && (
                    <ul className="strategies__menu" role="menu">
                      <li role="none">
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() =>
                            setModal({ kind: 'details', id: row.id })
                          }
                        >
                          Detalles
                        </button>
                      </li>
                      {editable(row) && (
                        <>
                          <li role="none">
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() =>
                                setModal({ kind: 'modify', id: row.id })
                              }
                            >
                              Modificar
                            </button>
                          </li>
                          <li role="none">
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() =>
                                operating(row)
                                  ? void switchOff(row)
                                  : void startActivation(row)
                              }
                            >
                              {operating(row) ? 'Apagar' : 'Activar en paper'}
                            </button>
                          </li>
                          <li role="none">
                            <button
                              type="button"
                              role="menuitem"
                              data-danger="true"
                              onClick={() =>
                                setModal({ kind: 'delete', id: row.id })
                              }
                            >
                              Borrar
                            </button>
                          </li>
                        </>
                      )}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <div className="strategies__detail" data-testid="strategy-pane">
        {notice && (
          <p role="status" className="strategies__notice">
            {notice}
          </p>
        )}
        {problem && (
          <p role="alert" className="strategies__notice" data-tone="warn">
            {problem}
          </p>
        )}
        {purge && <PurgeNotice name={purge.name} status={purge.status} />}
        {selected && (
          <StrategyRunView
            key={`${selected.id}:${selected.version}`}
            strategyId={selected.id}
            strategyName={selected.name}
            version={selected.version}
            kind={selected.kind}
            registry={api}
            onVariantStarted={(id, note) => done(id, note)}
            onModify={
              editable(selected)
                ? () => setModal({ kind: 'modify', id: selected.id })
                : undefined
            }
            onCreate={() => setModal({ kind: 'create' })}
          />
        )}
      </div>
      {modal?.kind === 'create' && (
        <StrategyEditorModal
          api={api}
          strategyId={null}
          onClose={() => setModal(null)}
          onSaved={done}
        />
      )}
      {modal?.kind === 'modify' && (
        <StrategyEditorModal
          api={api}
          strategyId={modal.id}
          onClose={() => setModal(null)}
          onSaved={done}
        />
      )}
      {modal?.kind === 'details' && open && (
        <StrategyDetailsModal
          api={api}
          row={open}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.kind === 'delete' && open && (
        <DeleteStrategyDialog
          api={api}
          id={open.id}
          name={open.name}
          onClose={() => setModal(null)}
          onDeleted={(status) => {
            setModal(null)
            setPurge({ name: open.name, status })
            setNotice(null)
            setLocalId(null)
            setRefresh((value) => value + 1)
          }}
        />
      )}
      {modal?.kind === 'activate' && open && (
        <ActivationDialog
          name={open.name}
          passed={modal.passed}
          busy={false}
          onConfirm={() => void activate(open)}
          onClose={() => setModal(null)}
        />
      )}
    </section>
  )
}
