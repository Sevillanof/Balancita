import type { ReactNode } from 'react'
import './mission-control.css'
import TopBar, { type NavigationItem } from './TopBar.tsx'

type AppShellProps = {
  navigation: readonly NavigationItem[]
  brandHref: string
  brandLabel: string
  status: ReactNode
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
  children,
}: AppShellProps) {
  return (
    <div className="demo-shell connected-terminal min-h-svh bg-canvas font-sans text-body text-ink">
      <TopBar
        brandHref={brandHref}
        brandLabel={brandLabel}
        navigation={navigation}
        status={status}
      />
      <main className="connected-terminal__main mx-auto w-shell-content pt-2 pb-12 header-stack:w-shell-content-compact header-stack:pt-5">
        {children}
      </main>
    </div>
  )
}
