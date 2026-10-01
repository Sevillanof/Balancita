import type { ReactNode } from 'react'

export default function ApprovedChartLegend({
  children,
}: {
  children: ReactNode
}) {
  return (
    <div className="demo-terminal__legend" data-testid="approved-chart-legend">
      {children}
    </div>
  )
}
