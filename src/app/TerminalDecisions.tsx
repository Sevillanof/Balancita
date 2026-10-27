import { useEffect, useRef, useState, type ReactNode } from 'react'
import { groupDecisions, type DecisionRow } from './terminal-decisions.ts'
import { DecisionChips, DecisionHead } from './DecisionGlyphs.tsx'
import {
  DECISION_TONES,
  TERMINAL_FRAME,
} from '../shared/design-system/terminal-styles.ts'

type Filter = 'all' | 'signals'

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

/** Fixed-height decisions list with its own scroll, plus the selected strip. */
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
  const list = useRef<HTMLUListElement>(null)
  // A decision picked on the chart brings its row into view inside the list.
  // Only the list's own scroll moves (never the page, so no jump on mobile),
  // and not on the first render: loading the Terminal must not scroll anything.
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
  }, [selectedId])
  const visible =
    filter === 'signals'
      ? rows.filter((r) => (r.view ? r.view.relevant : r.action !== 'WAIT'))
      : rows
  const items = groupDecisions(visible)
  return (
    <section
      className={`flex max-h-none flex-col overscroll-contain ${
        embedded
          ? 'h-auto overflow-visible'
          : `${TERMINAL_FRAME} overflow-y-auto ${!notice && rows.length > 0 ? 'h-140 header-phone:h-105' : 'h-auto'}`
      }`}
      aria-label="Decisiones del motor"
    >
      <div className="flex items-center justify-between gap-2">
        {embedded ? (
          <h3 className="clip-hidden">Decisiones del motor</h3>
        ) : (
          <h2>Decisiones del motor</h2>
        )}
        {!notice && rows.length > 0 && (
          <div role="group" aria-label="Filtro de decisiones">
            {(
              [
                ['all', 'Todas'],
                ['signals', 'Señales'],
              ] as const
            ).map(([value, label]) => (
              <button
                className="aria-pressed:font-bold!"
                key={value}
                type="button"
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
      {health ? <p role="status">{health}</p> : null}
      {notice ? (
        <p role="status">{notice}</p>
      ) : rows.length === 0 ? (
        <p>Aún no hay análisis registrados.</p>
      ) : (
        <ul
          ref={list}
          aria-label="Lista de decisiones"
          className={`m-0 min-h-30 shrink grow ${embedded ? 'basis-auto' : 'basis-0'} list-none overflow-y-auto overscroll-contain p-0 observer-history:max-h-120`}
        >
          {items.length === 0 && (
            <li className="border-t border-t-solid border-t-line py-1.5">
              No hay señales todavía.
            </li>
          )}
          {items.map((item) =>
            item.kind === 'waits' ? (
              <li
                key={item.rows[0]!.id}
                className="border-t border-t-solid border-t-line py-1.5 text-wait-run opacity-60"
              >
                {quietLabel(item.rows)} ×{item.rows.length} ·{' '}
                {item.rows.at(-1)!.time}–{item.rows[0]!.time}
              </li>
            ) : (
              <li
                className="border-t border-t-solid border-t-line py-1.5"
                key={item.row.id}
              >
                <button
                  className="grid w-full grid-cols-decisions cursor-pointer gap-x-2 gap-y-0.5 rounded-sm border-0 border-none border-current bg-transparent px-1.5 py-1 text-left text-inherit aria-pressed:bg-line aria-pressed:outline-0! aria-pressed:outline-current! aria-pressed:outline-none"
                  type="button"
                  aria-pressed={selectedId === item.row.id}
                  aria-label={`Seleccionar análisis ${item.row.id}`}
                  onClick={() => onSelect(item.row.id)}
                >
                  {item.row.view ? (
                    <>
                      <span className="col-span-2 flex flex-wrap items-center justify-between gap-2">
                        <DecisionHead view={item.row.view} />
                        <time className="text-ink-2">{item.row.time}</time>
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
                      <time>{item.row.time}</time>
                      <small className="col-span-full line-clamp-2 text-ink-2">
                        {item.row.reason}
                      </small>
                      {item.row.detail && (
                        <small className="col-span-full line-clamp-2 text-ink-2">
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
      )}
      {(selected || children) && (
        <div className="max-h-1/2 flex-initial overflow-y-auto border-t-2 border-t-solid border-t-line pt-2">
          {selected}
          {children}
        </div>
      )}
    </section>
  )
}
