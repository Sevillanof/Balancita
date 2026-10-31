import type { ReactNode } from 'react'

export type NavigationItem = {
  href: string
  label: string
  current?: boolean
}

type TopBarProps = {
  brandHref: string
  brandLabel: string
  navigation: readonly NavigationItem[]
  status: ReactNode
  center?: ReactNode
  market?: ReactNode
}

export default function TopBar({
  brandHref,
  brandLabel,
  navigation,
  status,
  center,
  market,
}: TopBarProps) {
  return (
    <header
      className="border-b border-b-solid border-line bg-canvas"
      data-testid="approved-trading-header"
    >
      <div className="grid grid-cols-main-auto items-center gap-x-3 gap-y-1 px-3 py-1.5 from-800:min-h-16 from-800:grid-cols-top-bar-wide from-1100:gap-x-5 from-1100:px-4">
        <div className="col-start-1 row-start-1 flex min-w-0 items-center gap-4 from-1100:gap-6">
          <a
            href={brandHref}
            aria-label={brandLabel}
            className="inline-flex size-8 flex-none items-center justify-center rounded-sm text-run-value leading-none"
          >
            <span aria-hidden="true">⚖️</span>
          </a>
          <nav
            className="flex items-center gap-4 from-1100:gap-5"
            aria-label="Navegación principal"
          >
            {navigation.map((item) => (
              <a
                key={item.href}
                href={item.href}
                aria-current={item.current ? 'page' : undefined}
                className={`inline-flex min-h-8 items-center border-b-2 border-b-solid px-0 py-1 text-hint whitespace-nowrap hover:text-ink! ${item.current ? 'border-info text-ink! font-semibold' : 'border-transparent text-ink-2!'}`}
              >
                {item.label}
              </a>
            ))}
          </nav>
        </div>
        {center && (
          <div className="col-start-1 row-start-2 flex min-w-0 items-center justify-start from-800:col-start-2 from-800:row-start-1 from-800:justify-center">
            {center}
          </div>
        )}
        {market && (
          <div className="col-start-2 row-start-2 min-w-0 text-right from-800:col-start-3 from-800:row-start-1">
            {market}
          </div>
        )}
        <div className="demo-shell__status col-start-2 row-start-1 flex min-w-0 items-center justify-end gap-2 from-800:col-start-4">
          {status}
        </div>
      </div>
    </header>
  )
}
