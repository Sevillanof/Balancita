import type { ReactNode } from 'react'
import { TERMINAL_FRAME } from '../../../shared/design-system/terminal-styles.ts'

export type PortfolioRow = {
  id: string
  cells: readonly ReactNode[]
}

type PortfolioTableProps = {
  title: string
  columns: readonly string[]
  rows: readonly PortfolioRow[]
  emptyLabel?: string
}

type ApprovedPortfolioTablesProps = {
  label: string
  title: string
  open: PortfolioTableProps
  closed: PortfolioTableProps
  summary?: ReactNode
  footnote?: ReactNode
  ariaLabel: string
}

function PortfolioTable({
  title,
  columns,
  rows,
  emptyLabel,
}: PortfolioTableProps) {
  return (
    <div className={TERMINAL_FRAME}>
      <h4 className="m-0 border-b border-b-solid border-b-line px-table-heading py-panel-heading text-provenance leading-normal">
        {title}
      </h4>
      {rows.length === 0 && emptyLabel ? (
        <p role="status">{emptyLabel}</p>
      ) : null}
      {rows.length === 0 && emptyLabel ? null : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse font-brand-mono text-table! leading-browser! whitespace-nowrap portfolio-cell:border-b portfolio-cell:border-b-solid portfolio-cell:border-b-line portfolio-cell:p-table-cell portfolio-cell:text-left portfolio-small:mt-chart-tight portfolio-small:block portfolio-small:text-ink-2">
            <thead>
              <tr>
                {columns.map((column) => (
                  <th className="font-medium text-ink-2" key={column}>
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  {row.cells.map((cell, index) => (
                    <td key={`${row.id}-${index}`}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export default function ApprovedPortfolioTables({
  label,
  title,
  open,
  closed,
  summary,
  footnote,
  ariaLabel,
}: ApprovedPortfolioTablesProps) {
  return (
    <section
      className="grid gap-3"
      aria-label={ariaLabel}
      data-testid="approved-portfolio-tables"
    >
      <div className="flex items-center justify-between gap-3 border-b border-b-solid border-b-line px-0 pt-0 pb-chart-inset chart-phone:flex-col chart-phone:items-start portfolio-summary:flex portfolio-summary:gap-4 portfolio-summary:text-table-summary portfolio-summary:leading-normal portfolio-summary:text-ink-2 chart-phone:portfolio-summary:flex-wrap portfolio-value:ml-chart-label portfolio-value:font-brand-mono">
        <div>
          <p className="mt-0 mr-0 mb-1.5 ml-0 font-brand-mono text-badge leading-normal font-medium tracking-eyebrow text-ink-2">
            {label}
          </p>
          <h3 className="mt-chart-unit mr-0 mb-0 ml-0 text-title leading-normal">
            {title}
          </h3>
        </div>
        {summary}
      </div>
      <div className="grid grid-cols-2 gap-4 terminal-stack:grid-cols-1">
        <PortfolioTable {...open} />
        <PortfolioTable {...closed} />
      </div>
      {footnote ? (
        <p className="m-0 p-0 text-table-mono leading-normal text-ink-2">
          {footnote}
        </p>
      ) : null}
    </section>
  )
}
