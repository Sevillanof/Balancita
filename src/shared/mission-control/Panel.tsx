import type { ReactNode } from 'react'

type PanelProps = {
  title?: ReactNode
  eyebrow?: ReactNode
  actions?: ReactNode
  /** Accessible name of the region when there is no visible title. */
  label?: string
  className?: string
  children: ReactNode
}

/** A docked container: optional header with title, eyebrow and actions. */
export default function Panel({
  title,
  eyebrow,
  actions,
  label,
  className,
  children,
}: PanelProps) {
  const hasHeader = title !== undefined || eyebrow !== undefined || actions
  return (
    <section
      className={className ? `mc-panel ${className}` : 'mc-panel'}
      aria-label={label}
    >
      {hasHeader && (
        <header className="mc-panel__header">
          <div className="mc-panel__titles">
            {eyebrow !== undefined && (
              <p className="mc-panel__eyebrow">{eyebrow}</p>
            )}
            {title !== undefined && (
              <h2 className="mc-panel__title">{title}</h2>
            )}
          </div>
          {actions && <div className="mc-panel__actions">{actions}</div>}
        </header>
      )}
      <div className="mc-panel__body">{children}</div>
    </section>
  )
}
