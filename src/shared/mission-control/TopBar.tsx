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
  /** Right side of the bar: health, product, mode. */
  status: ReactNode
  /** Middle of the bar, between navigation and status (the account balance). */
  center?: ReactNode
}

/** The shared header of every screen: brand, navigation and status. */
export default function TopBar({
  brandHref,
  brandLabel,
  navigation,
  status,
  center,
}: TopBarProps) {
  return (
    <header
      className="border-b border-b-solid border-line bg-canvas"
      data-testid="approved-trading-header"
    >
      <div className="mx-auto flex min-h-13 w-full max-w-shell items-center gap-7 px-6 py-1 header-wrap:flex-wrap header-wrap:gap-x-4.5 header-wrap:gap-y-2 header-stack:px-4 header-stack:pt-2 header-stack:pb-0 header-compact:gap-x-3">
        <a
          className="inline-flex flex-none items-center gap-2.5 text-value leading-normal font-semibold tracking-brand header-compact:text-brand-compact"
          href={brandHref}
          aria-label={brandLabel}
        >
          <span
            className="grid size-8 place-items-center rounded-brand bg-long font-brand-mono text-brand-mark font-bold text-canvas"
            aria-hidden="true"
          >
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
            balancita<span className="text-long">.</span>
          </span>
        </a>
        <nav
          className="flex self-stretch gap-1 header-stack:order-3 header-stack:w-full header-stack:overflow-x-auto header-phone:order-2 header-phone:ml-auto header-phone:w-auto"
          aria-label="Navegación principal"
        >
          {navigation.map((item) => (
            <a
              className={`inline-flex min-h-10 items-center border-b-2 border-b-solid px-3 py-0 text-hint whitespace-nowrap hover:text-long! ${item.current ? 'border-long text-long!' : 'border-transparent text-ink-2!'}`}
              href={item.href}
              aria-current={item.current ? 'page' : undefined}
              key={item.href}
            >
              {item.label}
            </a>
          ))}
        </nav>
        {center && (
          <div className="flex min-w-0 flex-1 items-center justify-center header-wrap:order-2 header-wrap:flex-none">
            {center}
          </div>
        )}
        <div className="demo-shell__status ml-auto flex min-w-0 items-center justify-end gap-4 header-wrap:order-3 header-wrap:w-full header-wrap:flex-wrap header-wrap:justify-start header-wrap:gap-2 header-wrap:pb-2">
          {status}
        </div>
      </div>
    </header>
  )
}
