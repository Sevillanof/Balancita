import type { ReactNode } from 'react'

type ApprovedChartToolbarProps = {
  instrument: ReactNode
  description: ReactNode
  controls: ReactNode
}

export default function ApprovedChartToolbar({
  instrument,
  description,
  controls,
}: ApprovedChartToolbarProps) {
  return (
    <div
      className="demo-terminal__panel-head"
      data-testid="approved-chart-toolbar"
    >
      <strong>{instrument}</strong>
      <span>{description}</span>
      {controls}
    </div>
  )
}
