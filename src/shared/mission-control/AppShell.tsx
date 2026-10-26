import type { ReactNode } from 'react'
import './mission-control.css'
import '../../app/DemoShell.css'
import '../../app/ConnectedTerminal.css'
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
    <div className="demo-shell connected-terminal">
      <TopBar
        brandHref={brandHref}
        brandLabel={brandLabel}
        navigation={navigation}
        status={status}
      />
      <main className="demo-shell__main connected-terminal__main">
        {children}
      </main>
    </div>
  )
}
