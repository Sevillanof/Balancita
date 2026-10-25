import { useEffect, useState } from 'react'
import { deriveStage } from '../domain/run-stage.ts'
import type { Standing } from '../domain/strategy-order.ts'
import { gateApi, type GateApi } from '../infrastructure/gate-api.ts'
import {
  runVisualApi,
  type RunVisualApi,
} from '../infrastructure/run-visual-api.ts'
import type { InventoryStrategy } from '../infrastructure/strategy-api.ts'

/**
 * Stage and latest «Neto por operación» of every strategy, read from the gate's
 * own records. A strategy the gate cannot read counts as «Hipótesis» without a figure.
 */
export function useStandings(
  rows: InventoryStrategy[] | null,
  gate: GateApi = gateApi,
  visual: RunVisualApi = runVisualApi,
): ReadonlyMap<string, Standing> {
  const [standings, setStandings] = useState<ReadonlyMap<string, Standing>>(
    new Map(),
  )
  const ids = rows?.map((row) => row.id).join('|') ?? ''
  useEffect(() => {
    if (!rows) return
    let alive = true
    void Promise.all(
      rows.map(async (row): Promise<[string, Standing]> => {
        try {
          const overview = await gate.overview(row.id)
          const stage = deriveStage(overview).index
          const finished = overview.runs
            .filter(
              (run) => run.status === 'done' && run.same_version !== false,
            )
            .sort((a, b) => b.id - a.id)
          const exam = overview.exam.taken ? overview.exam.run_id : null
          const latest = finished.find((run) => run.id === exam) ?? finished[0]
          if (!latest) return [row.id, { stage, meanBp: null }]
          const summary = await visual.summary(latest.id).catch(() => null)
          return [row.id, { stage, meanBp: summary?.summary?.mean_bp ?? null }]
        } catch {
          return [row.id, { stage: 0, meanBp: null }]
        }
      }),
    ).then((entries) => {
      if (alive) setStandings(new Map(entries))
    })
    return () => {
      alive = false
    }
    // `ids` stands for the rows: it changes when the set of strategies does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, gate, visual])
  return standings
}
