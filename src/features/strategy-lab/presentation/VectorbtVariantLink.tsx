import { RUN } from './run-view-styles.ts'
import { useEffect, useState } from 'react'
import type { StrategyApi } from '../infrastructure/strategy-api.ts'
import type { VectorbtApi } from '../infrastructure/vectorbt-api.ts'
import VectorbtCompare from './VectorbtCompare.tsx'

type Props = {
  api: VectorbtApi
  registry?: Pick<StrategyApi, 'detail'>
  strategyId: string
  /** The variant already has a finished practice run to compare. */
  hasPractice: boolean
}

type Link = {
  parentId: string
  parentName: string
  explorationId: string
  value: string
}

/**
 * On a variant born from a VectorBT exploration: the link back to it (the
 * `confirmed` mark the server keeps on the original's exploration) and, once its
 * practice has finished, «VectorBT vs simulador». Renders nothing for any other strategy.
 */
export default function VectorbtVariantLink({
  api,
  registry,
  strategyId,
  hasPractice,
}: Props) {
  const [link, setLink] = useState<Link | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!registry) return
    let alive = true
    void (async () => {
      try {
        const detail = await registry.detail(strategyId)
        const parent = detail.parent
        if (detail.origin !== 'vectorbt' || !parent) return
        const state = await api.status(parent.id)
        for (const exploration of state.explorations) {
          const entry = Object.entries(exploration.confirmed).find(
            ([, id]) => id === strategyId,
          )
          if (entry && alive) {
            setLink({
              parentId: parent.id,
              parentName: exploration.report?.strategy_name ?? parent.id,
              explorationId: exploration.id,
              value: entry[0],
            })
            return
          }
        }
      } catch {
        // Without the link the card simply has no comparison; nothing else depends on it.
      }
    })()
    return () => {
      alive = false
    }
  }, [api, registry, strategyId])

  if (!link) return null
  return (
    <section className="vbt-report" aria-label="Origen en VectorBT">
      <div className="vbt-report__head">
        <h4>Nació de una exploración de VectorBT</h4>
        <button
          type="button"
          aria-expanded={open}
          disabled={!hasPractice}
          onClick={() => setOpen((value) => !value)}
        >
          VectorBT vs simulador
        </button>
      </div>
      <p className={RUN.hint} data-testid="vbt-origin">
        Es una variante de «{link.parentName}» que VectorBT puso entre las
        mejores. Es un borrador: lo que valga lo dice el simulador.
        {!hasPractice &&
          ' Cuando termine su prueba de práctica vas a poder compararla con lo que había calculado VectorBT.'}
      </p>
      {open && hasPractice && (
        <VectorbtCompare
          api={api}
          strategyId={link.parentId}
          explorationId={link.explorationId}
          value={link.value}
          onClose={() => setOpen(false)}
        />
      )}
    </section>
  )
}
