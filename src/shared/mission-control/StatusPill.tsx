import type { ReactNode } from 'react'

import { STATUS_LABELS, type StatusTone } from './status.ts'

export default function StatusPill({
  tone,
  children,
}: {
  tone: StatusTone
  /** Defaults to the standard label of the tone. */
  children?: ReactNode
}) {
  return (
    <span className="mc-pill" data-tone={tone}>
      {children ?? STATUS_LABELS[tone]}
    </span>
  )
}
