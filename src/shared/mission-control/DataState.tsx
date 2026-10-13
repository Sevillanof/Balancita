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
      className="mc-datastate"
      data-kind={kind}
      role={kind === 'error' ? 'alert' : 'status'}
    >
      <p className="mc-datastate__title">{title ?? TITLES[kind]}</p>
      {detail !== undefined && <p className="mc-datastate__detail">{detail}</p>}
    </div>
  )
}
