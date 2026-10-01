import type { ReactNode } from 'react'

export type TradingNavigationItem = {
  href: string
  label: string
  current?: boolean
}

type ApprovedTradingHeaderProps = {
  brandHref: string
  brandLabel: string
  navigation: readonly TradingNavigationItem[]
  status: ReactNode
}

export default function ApprovedTradingHeader({
  brandHref,
  brandLabel,
  navigation,
  status,
}: ApprovedTradingHeaderProps) {
  return (
    <header
      className="demo-shell__header"
      data-testid="approved-trading-header"
    >
      <div className="demo-shell__header-inner">
        <a
          className="demo-shell__brand"
          href={brandHref}
          aria-label={brandLabel}
        >
          <span className="demo-shell__brand-mark" aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                d="M22 12h-4l-3 9L9 3l-3 9H2"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <span>
            balancita<span className="demo-shell__brand-period">.</span>
          </span>
        </a>
        <nav
          className="demo-shell__navigation"
          aria-label="Navegación principal"
        >
          {navigation.map((item) => (
            <a
              className="demo-shell__nav-link"
              href={item.href}
              aria-current={item.current ? 'page' : undefined}
              key={item.href}
            >
              {item.label}
            </a>
          ))}
        </nav>
        <div className="demo-shell__status">{status}</div>
      </div>
    </header>
  )
}
