import { RUN } from './run-view-styles.ts'
import type { ReactNode } from 'react'

type Segments = {
  done: number
  total: number
  /** Real progress of the test in course, 0 to 100. */
  live?: number
}

type Props = {
  label: string
  valueText: string
  /** Tramos: one piece per test, the current one pulses (Testear). */
  segments?: Segments
  /** Overall real progress, 0 to 100 (also what a screen reader hears). */
  percent?: number
  /** The line under the bar: phase, detail, buttons. */
  children?: ReactNode
}

/**
 * The progress bar under the stages of the strategy card. Two looks, one
 * style: pieces that advance test by test, or a fill that follows the real
 * work done.
 */
export default function RunProgress({
  label,
  valueText,
  segments,
  percent,
  children,
}: Props) {
  const now = Math.round(Math.min(Math.max(percent ?? 0, 0), 100))
  return (
    <div
      className={RUN.progress}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={now}
      aria-valuetext={valueText}
    >
      {segments ? (
        <ol className={RUN.progressSteps}>
          {Array.from({ length: segments.total }, (_, index) => (
            <li
              key={index}
              className={RUN.progressStep}
              data-state={
                index < segments.done
                  ? 'done'
                  : index === segments.done
                    ? 'current'
                    : 'todo'
              }
            >
              <span
                className={RUN.progressFill}
                data-testid="run-progress-fill"
                style={{
                  width: `${index < segments.done ? 100 : index === segments.done ? Math.min(Math.max(segments.live ?? 0, 0), 100) : 0}%`,
                }}
              />
            </li>
          ))}
        </ol>
      ) : (
        <div className={RUN.progressTrack} aria-hidden="true">
          <div
            className={RUN.progressFill}
            data-testid="run-progress-fill"
            style={{ width: `${Math.min(Math.max(percent ?? 0, 0), 100)}%` }}
          />
        </div>
      )}
      {children}
    </div>
  )
}
