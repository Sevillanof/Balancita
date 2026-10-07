import { useState, type ReactNode } from 'react'
import { groupDecisions, type DecisionRow } from './terminal-decisions.ts'

type Filter = 'all' | 'signals'

/** Fixed-height decisions list with its own scroll, plus the selected strip. */
export default function TerminalDecisions({
  rows,
  selectedId,
  onSelect,
  notice,
  selected,
  children,
}: {
  rows: DecisionRow[]
  selectedId: string
  onSelect: (id: string) => void
  /** Replaces the list when the engine has nothing to show. */
  notice?: ReactNode
  /** Detail of the selected decision (strip under the list). */
  selected?: ReactNode
  /** Extra detail below the strip (durable effects of the selection). */
  children?: ReactNode
}) {
  const [filter, setFilter] = useState<Filter>('all')
  const visible =
    filter === 'signals' ? rows.filter((r) => r.action !== 'WAIT') : rows
  const items = groupDecisions(visible)
  return (
    <section
      className="demo-terminal__panel connected-terminal__decisions"
      aria-label="Decisiones del motor"
    >
      <div className="connected-terminal__decisions-head">
        <h2>Decisiones del motor</h2>
        {!notice && rows.length > 0 && (
          <div role="group" aria-label="Filtro de decisiones">
            {(
              [
                ['all', 'Todas'],
                ['signals', 'Señales'],
              ] as const
            ).map(([value, label]) => (
              <button
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
      {notice ? (
        <p role="status">{notice}</p>
      ) : rows.length === 0 ? (
        <p>Aún no hay análisis registrados.</p>
      ) : (
        <ul className="connected-terminal__decision-list">
          {items.length === 0 && <li>No hay señales todavía.</li>}
          {items.map((item) =>
            item.kind === 'waits' ? (
              <li
                key={item.rows[0]!.id}
                className="connected-terminal__wait-run"
              >
                WAIT ×{item.rows.length} · {item.rows.at(-1)!.time}–
                {item.rows[0]!.time}
              </li>
            ) : (
              <li key={item.row.id}>
                <button
                  type="button"
                  aria-pressed={selectedId === item.row.id}
                  aria-label={`Seleccionar análisis ${item.row.id}`}
                  onClick={() => onSelect(item.row.id)}
                >
                  <strong>{item.row.action}</strong>
                  <span>{item.row.strategy}</span>
                  <time>{item.row.time}</time>
                  <small>{item.row.reason}</small>
                </button>
              </li>
            ),
          )}
        </ul>
      )}
      {selected}
      {children}
    </section>
  )
}
