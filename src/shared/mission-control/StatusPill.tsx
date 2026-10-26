import type { ReactNode } from 'react'

import { STATUS_LABELS, type StatusTone } from './status.ts'

const TONE_CLASSES: Record<StatusTone, string> = {
  ok: 'border-long/25 bg-long/10 text-long',
  warn: 'border-warn/25 bg-warn/10 text-warn',
  bad: 'border-short/25 bg-short/10 text-short',
  nodata: 'border-ink-2/25 bg-ink-2/10 text-ink-2',
}

export default function StatusPill({
  tone,
  children,
}: {
  tone: StatusTone
  /** Defaults to the standard label of the tone. */
  children?: ReactNode
}) {
  return (
    <span
      className={`inline-flex h-5 items-center gap-1.5 rounded-sm border border-solid px-2 py-0 text-label font-medium tracking-label whitespace-nowrap uppercase before:size-1.5 before:bg-current ${TONE_CLASSES[tone]}`}
      data-tone={tone}
    >
      {children ?? STATUS_LABELS[tone]}
    </span>
  )
}
