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
      className={`min-w-0 rounded-sm border border-solid border-line bg-surface-1 text-ink${className ? ` ${className}` : ''}`}
      aria-label={label}
    >
      {hasHeader && (
        <header className="flex items-baseline justify-between gap-3 border-b border-b-solid border-line px-4 py-3">
          <div className="min-w-0">
            {eyebrow !== undefined && (
              <p className="m-0 text-label font-medium tracking-label text-ink-2 uppercase">
                {eyebrow}
              </p>
            )}
            {title !== undefined && (
              <h2 className="m-0 text-title font-semibold tracking-title">
                {title}
              </h2>
            )}
          </div>
          {actions && (
            <div className="flex flex-none items-center gap-2">{actions}</div>
          )}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  )
}
