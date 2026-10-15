import type { ReactNode } from 'react'

export type StrategyViewTab<Id extends string = string> = {
  id: Id
  label: string
  /** Small count or note next to the label. */
  badge?: ReactNode
}

/**
 * In-page switch between the Estrategias views (inventory, laboratory, and the
 * ones stacked on top: C29 detail, experiment comparison). It is not a router
 * entry: the app navigation stays Terminal / Estrategias.
 */
export default function StrategyViewTabs<Id extends string>({
  tabs,
  current,
  onChange,
  trailing,
}: {
  tabs: readonly StrategyViewTab<Id>[]
  current: Id
  onChange: (id: Id) => void
  /** Header figures shown to the right of the tabs. */
  trailing?: ReactNode
}) {
  return (
    <div className="strategy-views">
      <div
        className="strategy-views__tabs"
        role="tablist"
        aria-label="Vistas de Estrategias"
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={current === tab.id}
            onClick={() => onChange(tab.id)}
          >
            {tab.label}
            {tab.badge !== undefined && (
              <span className="strategy-views__badge">{tab.badge}</span>
            )}
          </button>
        ))}
      </div>
      {trailing && <div className="strategy-views__trailing">{trailing}</div>}
    </div>
  )
}
