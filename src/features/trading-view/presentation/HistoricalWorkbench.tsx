import type { ReactNode } from 'react'
import '../../demo/history/historical.css'

export default function HistoricalWorkbench({
  form,
  results,
}: {
  form: ReactNode
  results: ReactNode
}) {
  return (
    <div className="demo-history__layout">
      {form}
      <div className="demo-history__results">{results}</div>
    </div>
  )
}
