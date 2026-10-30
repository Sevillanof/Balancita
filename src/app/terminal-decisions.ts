import type { DecisionView } from './terminal-decision-view.ts'

export type DecisionRow = {
  id: string
  action: string
  strategy: string
  reason: string
  time: string
  /** Optional formatted date + time (e.g. `30/10 10:15`) for display and search. */
  dateTime?: string
  /** Optional ISO date/time string (e.g. `2026-10-30 10:15`) for search matching. */
  searchText?: string
  /** Qwen's probability of each option, shown under the reason. */
  detail?: string
  /** A wait with its own reason (Qwen's): never collapsed into «WAIT ×N». */
  explained?: boolean
  /** Pictures-first reading (version 9): when present the list paints it instead of the text lines. */
  view?: DecisionView
}

export type DecisionItem =
  { kind: 'row'; row: DecisionRow } | { kind: 'waits'; rows: DecisionRow[] }

/** Newest first; runs of consecutive WAIT collapse into one "WAIT ×N" item. */
export function groupDecisions(rows: DecisionRow[]): DecisionItem[] {
  const items: DecisionItem[] = []
  for (const row of rows) {
    const last = items.at(-1)
    if (row.action !== 'WAIT' || row.explained) items.push({ kind: 'row', row })
    else if (last?.kind === 'waits') last.rows.push(row)
    else items.push({ kind: 'waits', rows: [row] })
  }
  return items.map((item) =>
    item.kind === 'waits' && item.rows.length === 1
      ? { kind: 'row', row: item.rows[0]! }
      : item,
  )
}
