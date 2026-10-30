import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  groupDecisions,
  type DecisionItem,
  type DecisionRow,
} from './terminal-decisions.ts'
import { DecisionChips, DecisionHead } from './DecisionGlyphs.tsx'
import {
  DECISION_TONES,
  TERMINAL_FRAME,
} from '../shared/design-system/terminal-styles.ts'

type Filter = 'all' | 'signals'
const PAGE_SIZE = 3
const COMPACT_BTN =
  'min-h-6 cursor-pointer rounded-sm border border-solid border-line bg-surface-1 px-2 py-0.5 text-hint text-ink enabled:hover:border-warn disabled:cursor-not-allowed disabled:opacity-50'

/** What a run of quiet looks is called: the old rows keep «WAIT». */
function quietLabel(rows: DecisionRow[]): string {
  const kinds = new Set(rows.map((r) => r.view?.kind))
  if (kinds.has(undefined)) return 'WAIT'
  return kinds.size === 1 && kinds.has('hold')
    ? 'Mantiene'
    : kinds.size === 1
      ? 'Espera'
      : 'Sin cambios'
}

function rowMatchesQuery(row: DecisionRow, needle: string): boolean {
  const haystack = [
    row.time,
    row.dateTime ?? '',
    row.searchText ?? '',
    row.action,
    row.strategy,
    row.reason,
    row.detail ?? '',
    row.view?.label ?? '',
    row.view?.motivo ?? '',
  ]
    .join(' ')
    .toLowerCase()
  return needle
    .split(/\s+/)
    .filter(Boolean)
    .every((part) => haystack.includes(part))
}

function itemHasId(item: DecisionItem, id: string): boolean {
  return item.kind === 'row'
    ? item.row.id === id
    : item.rows.some((r) => r.id === id)
}

/** Paginated decisions list (3 per page) with date/time search, plus the selected strip. */
export default function TerminalDecisions({
  rows,
  selectedId,
  onSelect,
  notice,
  health,
  selected,
  children,
  embedded = false,
}: {
  rows: DecisionRow[]
  selectedId: string
  onSelect: (id: string) => void
  /** Replaces the list when the engine has nothing to show. */
  notice?: ReactNode
  /** Warning about the operator process (no heartbeat, model down); shown above the list, never instead of it. */
  health?: ReactNode
  /** Detail of the selected decision (strip under the list). */
  selected?: ReactNode
  /** Extra detail below the strip (durable effects of the selection). */
  children?: ReactNode
  /** Inside the observer panel: no frame of its own, «Historial» heading. */
  embedded?: boolean
}) {
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const list = useRef<HTMLUListElement>(null)
  const needle = query.trim().toLowerCase()
  const bySignal =
    filter === 'signals'
      ? rows.filter((r) => (r.view ? r.view.relevant : r.action !== 'WAIT'))
      : rows
  const visible = needle
    ? bySignal.filter((r) => rowMatchesQuery(r, needle))
    : bySignal
  const items: DecisionItem[] = needle
    ? visible.map((row) => ({ kind: 'row', row }))
    : groupDecisions(visible)
  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages - 1)
  const pagedItems = items.slice(
    safePage * PAGE_SIZE,
    (safePage + 1) * PAGE_SIZE,
  )

  // A decision picked on the chart jumps to its page (adjusted while rendering, not in an effect) and brings its row into view.
  const [seenId, setSeenId] = useState(selectedId)
  if (seenId !== selectedId) {
    setSeenId(selectedId)
    const idx = items.findIndex((item) => itemHasId(item, selectedId))
    if (idx >= 0) {
      const targetPage = Math.floor(idx / PAGE_SIZE)
      if (targetPage !== safePage) setPage(targetPage)
    }
  }
  const firstRun = useRef(true)
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false
      return
    }
    const box = list.current
    const row = box?.querySelector<HTMLElement>('button[aria-pressed="true"]')
    if (!box || !row) return
    const boxRect = box.getBoundingClientRect()
    const rowRect = row.getBoundingClientRect()
    if (rowRect.top < boxRect.top) box.scrollTop -= boxRect.top - rowRect.top
    else if (rowRect.bottom > boxRect.bottom)
      box.scrollTop += rowRect.bottom - boxRect.bottom
  }, [selectedId, items, safePage])

  return (
    <section
      className={`flex max-h-none flex-col overscroll-contain ${
        embedded
          ? 'h-auto overflow-visible'
          : `${TERMINAL_FRAME} overflow-y-auto ${!notice && rows.length > 0 ? 'h-140 header-phone:h-105' : 'h-auto'}`
      }`}
      aria-label="Decisiones del motor"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        {embedded ? (
          <h3 className="clip-hidden">Decisiones del motor</h3>
        ) : (
          <h2>Decisiones del motor</h2>
        )}
        {!notice && rows.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 w-full justify-between">
            <input
              type="search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setPage(0)
              }}
              placeholder="Buscar fecha u hora (ej. 30/10 10:15)…"
              aria-label="Buscar señal por fecha u hora"
              className="min-h-6 min-w-0 flex-1 rounded-sm border border-solid border-line bg-surface-1 px-2 py-0.5 text-hint text-ink placeholder:text-ink-2"
            />
            <div
              role="group"
              aria-label="Filtro de decisiones"
              className="inline-flex gap-1"
            >
              {(
                [
                  ['all', 'Todas'],
                  ['signals', 'Señales'],
                ] as const
              ).map(([value, label]) => (
                <button
                  className={`${COMPACT_BTN} aria-pressed:font-bold!`}
                  key={value}
                  type="button"
                  aria-pressed={filter === value}
                  onClick={() => {
                    setFilter(value)
                    setPage(0)
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      {health ? <p role="status">{health}</p> : null}
      {notice ? (
        <p role="status">{notice}</p>
      ) : rows.length === 0 ? (
        <p>Aún no hay análisis registrados.</p>
      ) : (
        <>
          <ul
            ref={list}
            aria-label="Lista de decisiones"
            className="m-0 list-none overflow-y-auto overscroll-contain p-0"
          >
            {pagedItems.length === 0 && (
              <li className="border-t border-t-solid border-t-line py-1.5 text-hint text-ink-2">
                {needle
                  ? 'Sin resultados para esa fecha u hora.'
                  : 'No hay señales todavía.'}
              </li>
            )}
            {pagedItems.map((item) =>
              item.kind === 'waits' ? (
                <li
                  key={item.rows[0]!.id}
                  className="border-t border-t-solid border-t-line py-1 text-hint text-wait-run opacity-60"
                >
                  {quietLabel(item.rows)} ×{item.rows.length} ·{' '}
                  {item.rows.at(-1)!.dateTime ?? item.rows.at(-1)!.time}–
                  {item.rows[0]!.dateTime ?? item.rows[0]!.time}
                </li>
              ) : (
                <li
                  className="border-t border-t-solid border-t-line py-1"
                  key={item.row.id}
                >
                  <button
                    className="grid w-full grid-cols-decisions cursor-pointer gap-x-2 gap-y-0.5 rounded-sm border-0 border-none border-current bg-transparent px-1.5 py-0.5 text-left text-inherit aria-pressed:bg-line aria-pressed:outline-0! aria-pressed:outline-current! aria-pressed:outline-none"
                    type="button"
                    aria-pressed={selectedId === item.row.id}
                    aria-label={`Seleccionar análisis ${item.row.id}`}
                    onClick={() => onSelect(item.row.id)}
                  >
                    {item.row.view ? (
                      <>
                        <span className="col-span-2 flex flex-wrap items-center justify-between gap-2">
                          <DecisionHead view={item.row.view} />
                          <time className="text-hint text-ink-2">
                            {item.row.dateTime ?? item.row.time}
                          </time>
                        </span>
                        <span className="col-span-full">
                          <DecisionChips view={item.row.view} />
                        </span>
                      </>
                    ) : (
                      <>
                        <strong
                          className={DECISION_TONES[item.row.action]}
                          data-action={item.row.action}
                        >
                          {item.row.action}
                        </strong>
                        <span>{item.row.strategy}</span>
                        <time>{item.row.dateTime ?? item.row.time}</time>
                        <small className="col-span-full line-clamp-1 text-ink-2">
                          {item.row.reason}
                        </small>
                        {item.row.detail && (
                          <small className="col-span-full line-clamp-1 text-ink-2">
                            {item.row.detail}
                          </small>
                        )}
                      </>
                    )}
                  </button>
                </li>
              ),
            )}
          </ul>
          {items.length > PAGE_SIZE && (
            <div
              className="mt-1 flex items-center justify-between gap-2 border-t border-t-solid border-t-line pt-1 text-hint text-ink-2"
              aria-label="Paginación de señales"
            >
              <button
                type="button"
                className={COMPACT_BTN}
                disabled={safePage === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                Anterior
              </button>
              <span>
                {safePage + 1} / {totalPages}
              </span>
              <button
                type="button"
                className={COMPACT_BTN}
                disabled={safePage >= totalPages - 1}
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              >
                Siguiente
              </button>
            </div>
          )}
        </>
      )}
      {(selected || children) && (
        <div className="max-h-1/2 flex-initial overflow-y-auto border-t-2 border-t-solid border-t-line pt-1.5">
          {selected}
          {children}
        </div>
      )}
    </section>
  )
}
