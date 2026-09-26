import { useMemo } from 'react'
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from '@tanstack/react-table'
import type { StrategySummaryMetric } from './types.ts'

const euro = new Intl.NumberFormat('es-ES', {
  style: 'currency',
  currency: 'EUR',
})
const decimal = new Intl.NumberFormat('es-ES', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})
const percent = (value: number | null) =>
  value === null ? '—' : `${decimal.format(value)}%`

export default function StrategyCards({
  strategies,
  fastReplayBrier,
}: {
  strategies: readonly StrategySummaryMetric[]
  fastReplayBrier: Readonly<Record<string, number | null>>
}) {
  const columns = useMemo<ColumnDef<StrategySummaryMetric>[]>(
    () => [
      {
        id: 'strategy',
        header: 'Estrategia / estado',
        cell: ({ row }) => (
          <>
            <strong>{row.original.name}</strong>
            <br />
            {row.original.current_exposure === 'long' ? 'LONG' : 'FLAT'} ·{' '}
            {euro.format(row.original.assigned_capital_eur)}
          </>
        ),
      },
      { accessorKey: 'total_signals', header: 'Señales' },
      { accessorKey: 'gate_rejections', header: 'Rechazos Gate' },
      { accessorKey: 'executed_buys', header: 'Compras / fills' },
      {
        accessorKey: 'approval_rate_pct',
        header: 'Aprobación',
        cell: ({ getValue }) => percent(getValue<number>()),
      },
      {
        accessorKey: 'net_pnl_eur',
        header: 'PnL neto',
        cell: ({ row }) => (
          <span
            className={
              row.original.net_pnl_eur > 0
                ? 'strategy-analytics__positive'
                : row.original.net_pnl_eur < 0
                  ? 'strategy-analytics__negative'
                  : undefined
            }
          >
            {euro.format(row.original.net_pnl_eur)} (
            {percent(row.original.net_pnl_pct)})
          </span>
        ),
      },
      {
        accessorKey: 'gross_pnl_eur',
        header: 'PnL bruto',
        cell: ({ getValue }) => euro.format(getValue<number>()),
      },
      {
        accessorKey: 'total_fees_eur',
        header: 'Comisiones',
        cell: ({ getValue }) => euro.format(getValue<number>()),
      },
      {
        accessorKey: 'total_slippage_eur',
        header: 'Deslizamiento',
        cell: ({ getValue }) => euro.format(getValue<number>()),
      },
      {
        accessorKey: 'toll_ratio',
        header: 'Peaje / bruto',
        cell: ({ getValue }) => {
          const value = getValue<number | null>()
          return value === null ? '—' : percent(value * 100)
        },
      },
      {
        accessorKey: 'win_rate_pct',
        header: 'Acierto',
        cell: ({ getValue }) => percent(getValue<number>()),
      },
      {
        accessorKey: 'profit_factor',
        header: 'Factor de beneficio',
        cell: ({ getValue }) => {
          const value = getValue<number | null>()
          return value === null ? '—' : decimal.format(value)
        },
      },
      {
        accessorKey: 'avg_holding_bars_15m',
        header: 'Tenencia media',
        cell: ({ getValue }) => `${decimal.format(getValue<number>())} velas`,
      },
      {
        id: 'liveBrier',
        header: 'Brier en vivo',
        cell: () => 'N/A',
      },
      {
        id: 'fastReplayBrier',
        header: 'Brier Fast Replay',
        cell: ({ row }) => {
          const value = fastReplayBrier[row.original.strategy_id]
          return `${value == null ? 'Sin muestras' : value.toFixed(4)} vs baseline uniforme 0.6667`
        },
      },
    ],
    [fastReplayBrier],
  )
  const data = useMemo(() => [...strategies], [strategies])
  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
  })

  return (
    <div className="table-scroll">
      <table className="data-table strategy-analytics__table">
        <caption>Resumen de métricas por estrategia</caption>
        <thead>
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <th key={header.id} scope="col">
                  {header.isPlaceholder
                    ? null
                    : flexRender(
                        header.column.columnDef.header,
                        header.getContext(),
                      )}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr key={row.id}>
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
