import { signedAmount } from '../domain/strategy-format.ts'
import { amount } from '../../../shared/finance/format.ts'

/** One closed operation, whatever produced it (a gate run, the quick test, the formula test). */
export type VisualTrade = {
  label: string
  entryMs: number
  exitMs: number
  bp: number
  why: string
}

export type VisualSeries = {
  id: string
  label: string
  trades: VisualTrade[]
}

const COLORS = [
  'text-ink',
  'text-info',
  'text-ink-2',
  'text-warn',
  'text-ink-2',
] as const
const DASH = [undefined, undefined, '4 3', '2 3', '6 3'] as const

const WHEN = new Intl.DateTimeFormat('es-ES', {
  timeZone: 'Europe/Madrid',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
})
const DAY = new Intl.DateTimeFormat('es-ES', {
  timeZone: 'Europe/Madrid',
  day: 'numeric',
  month: 'short',
})

const usdOf = (bp: number, notional: number) => (bp / 1e4) * notional

/** `+12,40 USD` when the notional is known, `+124,0 pb` when not. */
function moneyText(bp: number, notional: number): string {
  return notional > 0
    ? `${signedAmount(usdOf(bp, notional), 2) ?? '0,00'} USD`
    : `${signedAmount(bp, 1) ?? '0,0'} pb`
}

const total = (trades: VisualTrade[]) =>
  trades.reduce((sum, trade) => sum + trade.bp, 0)

/** Running total after each close, from 0: `[x, y]` pairs for the balance curve. */
function curve(trades: VisualTrade[]): Array<[number, number]> {
  const sorted = [...trades].sort((a, b) => a.exitMs - b.exitMs)
  let run = 0
  return sorted.map((trade) => [trade.exitMs, (run += trade.bp)])
}

const W = 640
const H = 190
const PAD = { left: 8, right: 8, top: 10, bottom: 18 }

function BalanceCurve({
  series,
  notional,
}: {
  series: VisualSeries[]
  notional: number
}) {
  const lines = series.map((item) => curve(item.trades))
  const points = lines.flat()
  if (points.length === 0) return null
  const times = points.map((p) => p[0])
  const lo = Math.min(...times)
  const hi = Math.max(...times)
  const ys = [0, ...points.map((p) => p[1])]
  const yLo = Math.min(...ys)
  const yHi = Math.max(...ys)
  const x = (t: number) =>
    PAD.left +
    (hi === lo ? 0.5 : (t - lo) / (hi - lo)) * (W - PAD.left - PAD.right)
  const y = (v: number) =>
    PAD.top +
    (yHi === yLo ? 0.5 : (yHi - v) / (yHi - yLo)) * (H - PAD.top - PAD.bottom)
  const zero = y(0)
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="Curva de saldo acumulado"
      className="w-full"
    >
      <line
        x1={PAD.left}
        x2={W - PAD.right}
        y1={zero}
        y2={zero}
        className="stroke-line-strong"
        strokeDasharray="3 3"
      />
      {lines.map((line, index) => {
        if (line.length === 0) return null
        const path = [[lo, 0] as [number, number], ...line]
          .map(
            ([t, v], i) =>
              `${i ? 'L' : 'M'}${x(t).toFixed(1)} ${y(v).toFixed(1)}`,
          )
          .join(' ')
        const last = line[line.length - 1]!
        return (
          <g key={series[index]!.id} className={COLORS[index % COLORS.length]}>
            <path
              d={path}
              fill="none"
              stroke="currentColor"
              strokeWidth={index === 0 ? 2.5 : 1.5}
              strokeDasharray={DASH[index % DASH.length]}
              strokeLinejoin="round"
            />
            {index === 0 &&
              series[0]!.trades.map((trade) => {
                const at = line.find((p) => p[0] === trade.exitMs)
                if (!at) return null
                return (
                  <circle
                    key={`${trade.entryMs}:${trade.label}`}
                    cx={x(at[0])}
                    cy={y(at[1])}
                    r={2.5}
                    className={trade.bp >= 0 ? 'fill-long' : 'fill-short'}
                  >
                    <title>{tradeTitle(trade, notional)}</title>
                  </circle>
                )
              })}
            <circle
              cx={x(last[0])}
              cy={y(last[1])}
              r={3.5}
              fill="currentColor"
            />
          </g>
        )
      })}
      <text x={PAD.left} y={H - 4} className="fill-ink-2 text-[10px]">
        {DAY.format(lo)}
      </text>
      <text
        x={W - PAD.right}
        y={H - 4}
        textAnchor="end"
        className="fill-ink-2 text-[10px]"
      >
        {DAY.format(hi)}
      </text>
    </svg>
  )
}

function tradeTitle(trade: VisualTrade, notional: number) {
  return `${trade.label} · entró ${WHEN.format(trade.entryMs)} · salió ${WHEN.format(trade.exitMs)} · ${moneyText(trade.bp, notional)} (${signedAmount(trade.bp, 1)} pb) · ${trade.why}`
}

/** One bar per operation, in order: green above the line, red below. */
function TradeBars({
  trades,
  notional,
}: {
  trades: VisualTrade[]
  notional: number
}) {
  const sorted = [...trades].sort((a, b) => a.entryMs - b.entryMs)
  if (sorted.length === 0) return null
  const biggest = Math.max(...sorted.map((t) => Math.abs(t.bp)), 1)
  const half = 36
  const gap = sorted.length > 120 ? 0 : 1
  const width = Math.max(1, (W - gap * sorted.length) / sorted.length)
  return (
    <svg
      viewBox={`0 0 ${W} ${half * 2}`}
      role="img"
      aria-label="Resultado de cada operación"
      className="w-full"
    >
      <line x1={0} x2={W} y1={half} y2={half} className="stroke-line-strong" />
      {sorted.map((trade, index) => {
        const h = Math.max(1, (Math.abs(trade.bp) / biggest) * (half - 2))
        return (
          <rect
            key={`${trade.entryMs}:${index}`}
            x={index * (width + gap)}
            y={trade.bp >= 0 ? half - h : half}
            width={width}
            height={h}
            className={trade.bp >= 0 ? 'fill-long' : 'fill-short'}
          >
            <title>{tradeTitle(trade, notional)}</title>
          </rect>
        )
      })}
    </svg>
  )
}

/** The total of each series as a bar, from a common zero. */
function TotalsBars({
  series,
  notional,
}: {
  series: VisualSeries[]
  notional: number
}) {
  const totals = series.map((item) => total(item.trades))
  const biggest = Math.max(...totals.map(Math.abs), 1)
  return (
    <ul
      className="m-0 grid list-none gap-1.5 p-0"
      aria-label="Ganancia total por variante"
    >
      {series.map((item, index) => {
        const value = totals[index]!
        return (
          <li
            key={item.id}
            className="grid grid-cols-[minmax(0,12rem)_1fr_auto] items-center gap-2 text-note"
          >
            <span className="truncate text-ink-2" title={item.label}>
              {item.label}
            </span>
            <span className="relative block h-3 rounded-sm bg-surface-2">
              <span
                className={`absolute inset-y-0 rounded-sm ${value >= 0 ? 'bg-long' : 'bg-short'}`}
                style={{
                  width: `${(Math.abs(value) / biggest) * 100}%`,
                }}
              />
            </span>
            <span
              className={`tabular-nums ${value >= 0 ? 'text-long' : 'text-short'}`}
            >
              {moneyText(value, notional)}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

/**
 * Results at a glance: the net total big, the balance curve (the first series is the main one, with a mark at each close),
 * one bar per operation and the total of each series side by side. Little text: the numbers are in the tooltips.
 */
export default function ResultsVisual({
  series,
  notionalUsd,
  note,
}: {
  series: VisualSeries[]
  notionalUsd: number
  note?: string
}) {
  const main = series[0]
  if (!main) return null
  const net = total(main.trades)
  const wins = main.trades.filter((t) => t.bp > 0).length
  const n = main.trades.length
  return (
    <div
      className="grid min-w-0 gap-3 rounded-lg border border-solid border-line bg-canvas px-3.5 py-3"
      data-testid="results-visual"
    >
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-1">
        <div className="grid gap-0.5">
          <span className="text-note text-ink-2">
            Ganancia total neta · {main.label}
          </span>
          <strong
            data-testid="results-total"
            className={`text-[2rem] leading-none tabular-nums ${n === 0 ? 'text-ink-2' : net >= 0 ? 'text-long' : 'text-short'}`}
          >
            {n === 0 ? 'Sin operaciones' : moneyText(net, notionalUsd)}
          </strong>
        </div>
        {n > 0 && (
          <span className="text-note text-ink-2 tabular-nums">
            {n} operaciones · {amount((wins / n) * 100, 0)} % ganadoras ·{' '}
            {signedAmount(net / n, 1)} pb cada una
          </span>
        )}
      </div>
      {n > 0 && (
        <>
          <BalanceCurve series={series} notional={notionalUsd} />
          {series.length > 1 && (
            <ul
              className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-note text-ink-2"
              aria-label="Leyenda de la curva"
            >
              {series.map((item, index) => (
                <li key={item.id} className={COLORS[index % COLORS.length]}>
                  <b aria-hidden="true">{index === 0 ? '━' : '┅'}</b>{' '}
                  <span className="text-ink-2">{item.label}</span>
                </li>
              ))}
            </ul>
          )}
          <TradeBars trades={main.trades} notional={notionalUsd} />
          {series.length > 1 && (
            <TotalsBars series={series} notional={notionalUsd} />
          )}
        </>
      )}
      {note && <p className="m-0 text-note text-ink-2">{note}</p>}
    </div>
  )
}
