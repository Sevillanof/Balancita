import type { ReactNode } from 'react'

export type DataStateKind =
  'loading' | 'error' | 'empty' | 'unavailable' | 'nodata'

const TITLES: Record<DataStateKind, string> = {
  loading: 'Cargando…',
  error: 'Error',
  empty: 'Sin elementos',
  unavailable: 'No disponible',
  nodata: 'Sin datos',
}

const KIND_CLASSES: Record<DataStateKind, { border: string; title: string }> = {
  loading: { border: 'border-line-strong', title: 'text-ink' },
  error: { border: 'border-short/40', title: 'text-short' },
  empty: { border: 'border-line-strong', title: 'text-ink' },
  unavailable: { border: 'border-line-strong', title: 'text-ink' },
  nodata: { border: 'border-line-strong', title: 'text-ink' },
}

type DataStateProps = {
  kind: DataStateKind
  /** Replaces the default title of the kind. */
  title?: string
  /** Why: the verifiable reason, never an invented explanation. */
  detail?: ReactNode
}

/** One placeholder for every non-happy data state. */
export default function DataState({ kind, title, detail }: DataStateProps) {
  return (
    <div
      className={`grid gap-1 rounded-sm border border-dashed p-4 text-note text-ink-2 ${KIND_CLASSES[kind].border}`}
      data-kind={kind}
      role={kind === 'error' ? 'alert' : 'status'}
    >
      <p className={`m-0 font-semibold ${KIND_CLASSES[kind].title}`}>
        {title ?? TITLES[kind]}
      </p>
      {detail !== undefined && <p className="m-0">{detail}</p>}
    </div>
  )
}
