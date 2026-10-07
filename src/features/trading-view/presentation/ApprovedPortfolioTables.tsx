import type { ReactNode } from 'react'

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
    <div className="demo-terminal__panel">
      <h4>{title}</h4>
      {rows.length === 0 && emptyLabel ? (
        <p role="status">{emptyLabel}</p>
      ) : null}
      {rows.length === 0 && emptyLabel ? null : (
        <div className="demo-terminal__table-scroll">
          <table>
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={column}>{column}</th>
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
      className="demo-terminal__results"
      aria-label={ariaLabel}
      data-testid="approved-portfolio-tables"
    >
      <div className="demo-terminal__results-heading">
        <div>
          <p className="demo-shell__eyebrow">{label}</p>
          <h3>{title}</h3>
        </div>
        {summary}
      </div>
      <div className="demo-terminal__tables">
        <PortfolioTable {...open} />
        <PortfolioTable {...closed} />
      </div>
      {footnote ? <p className="demo-terminal__footnote">{footnote}</p> : null}
    </section>
  )
}
