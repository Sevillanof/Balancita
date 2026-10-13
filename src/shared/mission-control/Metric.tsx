import type { ReactNode } from 'react'

export type MetricTone = 'up' | 'down' | 'neutral'

type MetricProps = {
  label: string
  /** Already formatted by the caller; Metric never computes or rounds. */
  value: ReactNode
  delta?: ReactNode
  hint?: ReactNode
  tone?: MetricTone
}

/** A labelled figure. It only presents a value it is given. */
export default function Metric({
  label,
  value,
  delta,
  hint,
  tone = 'neutral',
}: MetricProps) {
  return (
    <div className="mc-metric" data-tone={tone}>
      <span className="mc-metric__label">{label}</span>
      <span className="mc-metric__value">{value}</span>
      {delta !== undefined && <span className="mc-metric__delta">{delta}</span>}
      {hint !== undefined && <span className="mc-metric__hint">{hint}</span>}
    </div>
  )
}
