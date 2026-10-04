import type { ReactNode } from 'react'

type ApprovedTerminalLayoutProps = {
  chart: ReactNode
  decisions: ReactNode
}

export default function ApprovedTerminalLayout({
  chart,
  decisions,
}: ApprovedTerminalLayoutProps) {
  return (
    <div className="demo-terminal__grid" data-testid="approved-terminal-layout">
      {chart}
      {decisions}
    </div>
  )
}
