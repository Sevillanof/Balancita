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

const TONE_CLASSES: Record<MetricTone, string> = {
  up: 'text-long',
  down: 'text-short',
  neutral: '',
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
    <div className="grid min-w-0 gap-1 tabular-nums" data-tone={tone}>
      <span className="text-label font-medium tracking-label text-ink-2 uppercase">
        {label}
      </span>
      <span
        className={`wrap-anywhere text-value font-semibold tracking-title ${TONE_CLASSES[tone]}`}
      >
        {value}
      </span>
      {delta !== undefined && (
        <span
          className={`text-hint ${tone === 'neutral' ? 'text-ink-2' : TONE_CLASSES[tone]}`}
        >
          {delta}
        </span>
      )}
      {hint !== undefined && (
        <span className="text-hint text-ink-2">{hint}</span>
      )}
    </div>
  )
}
