import type { ReactNode } from 'react'
import TopBar, { type NavigationItem } from './TopBar.tsx'

type AppShellProps = {
  navigation: readonly NavigationItem[]
  brandHref: string
  brandLabel: string
  status: ReactNode
  center?: ReactNode
  market?: ReactNode
  viewport?: boolean
  children: ReactNode
}

/**
 * Layout shared by Terminal and Estrategias: one top bar and one main area.
 * The page decides what goes inside; the shell decides nothing about data.
 */
export default function AppShell({
  navigation,
  brandHref,
  brandLabel,
  status,
  center,
  market,
  viewport = false,
  children,
}: AppShellProps) {
  return (
    <div
      data-testid="app-shell"
      data-layout={viewport ? 'viewport' : 'document'}
      className={`${viewport ? 'grid h-dvh grid-rows-shell' : 'min-h-screen'} bg-canvas font-sans text-body text-ink font-features-terminal shell-link:text-inherit shell-link:no-underline shell-link-focus:outline-2! shell-link-focus:outline-long! shell-link-focus:outline-offset-2! shell-button-focus:outline-2! shell-button-focus:outline-long! shell-button-focus:outline-offset-2! shell-table:w-full shell-table:border-collapse shell-table:text-table shell-cell:border-b shell-cell:border-b-solid shell-cell:border-b-line shell-cell:p-table-cell shell-cell:text-left shell-cell:whitespace-nowrap shell-th:font-medium shell-th:text-ink-2 shell-selected-row:bg-row-selected`}
    >
      <TopBar
        brandHref={brandHref}
        brandLabel={brandLabel}
        navigation={navigation}
        status={status}
        center={center}
        market={market}
      />
      <main
        className={
          viewport
            ? 'flex min-h-0 min-w-0 flex-col p-2 from-1000:p-3'
            : 'min-w-0 w-shell-content overflow-x-clip pt-0 px-7.5 pb-5'
        }
      >
        {children}
      </main>
    </div>
  )
}
