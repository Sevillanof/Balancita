import { useState } from 'react'
import { signedAmount } from '../domain/strategy-format.ts'
import { amount } from '../../../shared/finance/format.ts'

/** One closed operation, whatever produced it (a gate run, the quick test, the formula test). */
export type VisualTrade = {
  /** Set when the screen has its own chart to jump to (`onPick`). */
  id?: string
  product?: string
  side?: 1 | -1
  /** The maestro at the entry (−2…+2) and the portero, when the rule has them. */
  maestro?: number
  portero?: boolean
  /** `vuelta` (the maestro turned), `tiempo` (the safety limit) or free text. */
  exit?: string
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

/** The price itself over the period: hourly closes `[ms, price]`, drawn as buy and hold with the same notional. */
export type MarketLine = {
  id: string
  label: string
  points: Array<[number, number]>
}

/** Return in bp of holding from the first point, by time. */
const marketCurve = (line: MarketLine): Array<[number, number]> => {
  const first = line.points[0]?.[1]
  return first
    ? line.points.map(([t, price]) => [t, (price / first - 1) * 1e4])
    : []
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
  market,
  notional,
}: {
  series: VisualSeries[]
  market: MarketLine[]
  notional: number
}) {
  const lines = series.map((item) => curve(item.trades))
  const held = market.map(marketCurve)
  const points = [...lines.flat(), ...held.flat()]
  if (lines.flat().length === 0) return null
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
      {held.map((line, index) => {
        if (line.length === 0) return null
        const path = line
          .map(
            ([t, v], i) =>
              `${i ? 'L' : 'M'}${x(t).toFixed(1)} ${y(v).toFixed(1)}`,
          )
          .join(' ')
        return (
          <path
            key={market[index]!.id}
            d={path}
            fill="none"
            className="stroke-warn"
            strokeWidth={1}
            opacity={0.8}
          >
            <title>{market[index]!.label}</title>
          </path>
        )
      })}
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
      <text x={PAD.left} y={H - 4} className="fill-ink-2 text-hint">
        {DAY.format(lo)}
      </text>
      <text
        x={W - PAD.right}
        y={H - 4}
        textAnchor="end"
        className="fill-ink-2 text-hint"
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
  picked,
  onPick,
}: {
  trades: VisualTrade[]
  notional: number
  picked: VisualTrade | null
  onPick: (trade: VisualTrade) => void
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
            role="button"
            tabIndex={0}
            aria-label={tradeTitle(trade, notional)}
            aria-pressed={picked === trade}
            onClick={() => onPick(trade)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onPick(trade)
              }
            }}
            className={`cursor-pointer ${trade.bp >= 0 ? 'fill-long' : 'fill-short'} ${picked === trade ? 'stroke-ink' : ''}`}
          >
            <title>{tradeTitle(trade, notional)}</title>
          </rect>
        )
      })}
    </svg>
  )
}

const arrows = (maestro: number | undefined) =>
  maestro == null
    ? ''
    : `${maestro > 0 ? '▲' : '▼'}${Math.abs(maestro) >= 2 ? (maestro > 0 ? '▲' : '▼') : ''}`

const exitBadge = (trade: VisualTrade) =>
  trade.exit === 'tiempo'
    ? '⏱ tope'
    : trade.exit === 'vuelta'
      ? '↩ maestro'
      : (trade.exit ?? '×')

/** One operation as it was: the price around it, the stretch held shaded green or red, and an entry and an exit mark with why. */
function TradeFocus({
  trade,
  points,
  notional,
}: {
  trade: VisualTrade
  points: Array<[number, number]>
  notional: number
}) {
  const span = trade.exitMs - trade.entryMs
  const pad = Math.max(6 * 3600000, span * 0.4)
  const lo = trade.entryMs - pad
  const hi = trade.exitMs + pad
  const near = points.filter(([t]) => t >= lo && t <= hi)
  if (near.length < 2)
    return (
      <p className="m-0 text-note text-ink-2">
        Sin precios guardados para dibujar esta operación.
      </p>
    )
  const priceAt = (ms: number) =>
    near.reduce((best, p) =>
      Math.abs(p[0] - ms) < Math.abs(best[0] - ms) ? p : best,
    )[1]
  const values = near.map((p) => p[1])
  const vLo = Math.min(...values)
  const vHi = Math.max(...values)
  const top = 22
  const bottom = 14
  const x = (t: number) => 8 + ((t - lo) / (hi - lo)) * (W - 16)
  const y = (v: number) =>
    top + (vHi === vLo ? 0.5 : (vHi - v) / (vHi - vLo)) * (170 - top - bottom)
  const path = near
    .map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)} ${y(v).toFixed(1)}`)
    .join(' ')
  const win = trade.bp >= 0
  const ex = x(trade.entryMs)
  const xx = x(trade.exitMs)
  const long = (trade.side ?? 1) > 0
  return (
    <div className="grid gap-1" data-testid="trade-focus">
      <svg
        viewBox={`0 0 ${W} 170`}
        role="img"
        aria-label={`Operación del ${WHEN.format(trade.entryMs)}`}
        className="w-full"
      >
        <rect
          x={ex}
          y={top - 4}
          width={Math.max(2, xx - ex)}
          height={170 - top - bottom + 8}
          className={win ? 'fill-long' : 'fill-short'}
          opacity={0.18}
        />
        <path d={path} fill="none" className="stroke-ink" strokeWidth={1.5} />
        <g className={long ? 'fill-long' : 'fill-short'}>
          <path
            d={
              long
                ? `M${ex} ${y(priceAt(trade.entryMs)) - 3} l-6 10 h12 z`
                : `M${ex} ${y(priceAt(trade.entryMs)) + 3} l-6 -10 h12 z`
            }
          />
        </g>
        <text x={ex} y={12} textAnchor="middle" className="fill-ink text-hint">
          {`${long ? 'LARGO' : 'CORTO'} ${arrows(trade.maestro)}${trade.portero == null ? '' : trade.portero ? ' ✓' : ' ✗'}`}
        </text>
        <circle
          cx={xx}
          cy={y(priceAt(trade.exitMs))}
          r={4.5}
          className={win ? 'fill-long' : 'fill-short'}
        />
        <text
          x={xx}
          y={12}
          textAnchor={xx > W - 90 ? 'end' : 'middle'}
          className="fill-ink text-hint"
        >
          {`${exitBadge(trade)} ${moneyText(trade.bp, notional)}`}
        </text>
        <text x={8} y={166} className="fill-ink-2 text-hint">
          {WHEN.format(lo)}
        </text>
        <text
          x={W - 8}
          y={166}
          textAnchor="end"
          className="fill-ink-2 text-hint"
        >
          {WHEN.format(hi)}
        </text>
      </svg>
    </div>
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
          <li key={item.id} className="flex items-center gap-2 text-note">
            <span
              className="w-48 shrink-0 truncate text-ink-2"
              title={item.label}
            >
              {item.label}
            </span>
            <span className="relative block h-3 min-w-0 grow rounded-sm bg-surface-2">
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
  market = [],
  notionalUsd,
  note,
  onPick,
}: {
  series: VisualSeries[]
  market?: MarketLine[]
  notionalUsd: number
  note?: string
  /** The screen has its own chart: a click on a bar goes there instead of opening the price below. */
  onPick?: (trade: VisualTrade) => void
}) {
  const [picked, setPicked] = useState<VisualTrade | null>(null)
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
            className={`text-run-value leading-none tabular-nums ${n === 0 ? 'text-ink-2' : net >= 0 ? 'text-long' : 'text-short'}`}
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
          <BalanceCurve
            series={series}
            market={market}
            notional={notionalUsd}
          />
          {(series.length > 1 || market.length > 0) && (
            <ul
              className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-note text-ink-2"
              aria-label="Leyenda de la curva"
            >
              {market.map((line) => (
                <li key={line.id} className="text-warn">
                  <b aria-hidden="true">━</b>{' '}
                  <span className="text-ink-2">{line.label}</span>
                </li>
              ))}
              {series.map((item, index) => (
                <li key={item.id} className={COLORS[index % COLORS.length]}>
                  <b aria-hidden="true">{index === 0 ? '━' : '┅'}</b>{' '}
                  <span className="text-ink-2">{item.label}</span>
                </li>
              ))}
            </ul>
          )}
          <TradeBars
            trades={main.trades}
            notional={notionalUsd}
            picked={picked}
            onPick={(trade) => {
              if (onPick) onPick(trade)
              else setPicked((now) => (now === trade ? null : trade))
            }}
          />
          {picked && !onPick && (
            <TradeFocus
              trade={picked}
              points={
                (market.find((line) => line.id === picked.product) ?? market[0])
                  ?.points ?? []
              }
              notional={notionalUsd}
            />
          )}
          {series.length > 1 && (
            <TotalsBars series={series} notional={notionalUsd} />
          )}
        </>
      )}
      {note && <p className="m-0 text-note text-ink-2">{note}</p>}
    </div>
  )
}
