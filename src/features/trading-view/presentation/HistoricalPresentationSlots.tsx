import type { ReactNode } from 'react'

export type HistoricalMetricItem = { label: string; value: string }

export function HistoricalMetricCards({
  items,
}: {
  items: readonly HistoricalMetricItem[]
}) {
  return (
    <div className="demo-history__metrics" aria-label="Métricas disponibles">
      {items.map(({ label, value }) => (
        <div className="demo-history__panel demo-history__metric" key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  )
}

export function HistoricalPanel({
  title,
  caption,
  variant,
  children,
}: {
  title: string
  caption?: string
  variant: 'curve' | 'trades'
  children: ReactNode
}) {
  return (
    <section
      className={`demo-history__panel demo-history__${variant}`}
      aria-label={title}
    >
      {variant === 'curve' ? (
        <div>
          <h2>{title}</h2>
          {caption && <span>{caption}</span>}
        </div>
      ) : (
        <h2>{title}</h2>
      )}
      {children}
    </section>
  )
}

export function HistoricalTable({ children }: { children: ReactNode }) {
  return <div className="demo-history__table-scroll">{children}</div>
}
