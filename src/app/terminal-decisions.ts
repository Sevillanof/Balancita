export type DecisionRow = {
  id: string
  action: string
  strategy: string
  reason: string
  time: string
}

export type DecisionItem =
  { kind: 'row'; row: DecisionRow } | { kind: 'waits'; rows: DecisionRow[] }

/** Newest first; runs of consecutive WAIT collapse into one "WAIT ×N" item. */
export function groupDecisions(rows: DecisionRow[]): DecisionItem[] {
  const items: DecisionItem[] = []
  for (const row of rows) {
    const last = items.at(-1)
    if (row.action !== 'WAIT') items.push({ kind: 'row', row })
    else if (last?.kind === 'waits') last.rows.push(row)
    else items.push({ kind: 'waits', rows: [row] })
  }
  return items.map((item) =>
    item.kind === 'waits' && item.rows.length === 1
      ? { kind: 'row', row: item.rows[0]! }
      : item,
  )
}
