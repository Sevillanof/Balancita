import { useMemo } from 'react'
import { signedAmount } from '../domain/strategy-format.ts'
import { tradePotential } from '../domain/trade-potential.ts'
import type { RunCandle, RunTrade } from '../infrastructure/run-visual-api.ts'

const W = 900
const H = 300
const PAD_X = 10
/** Room kept on the right for the price labels, so that the price line never runs over them. */
const PAD_R = 56
const PAD_Y = 14
const PAD_ZOOM_Y = 34

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
  year: '2-digit',
})

const notionalOf = (trades: RunTrade[]) =>
  Number(trades.find((t) => t.notional_usd)?.notional_usd) || 0

/** `+0,12 USD` when the notional is known, `+12 pb` when not. */
function money(bp: number, notional: number): string {
  return notional > 0
    ? `${signedAmount((bp / 1e4) * notional, 2) ?? '0,00'} USD`
    : `${signedAmount(bp, 0) ?? '0'} pb`
}

const priceOf = (value: string | null) => {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

/** What the movement analyst said at the entry: `null` when it was off or had no history. */
const movementOf = (trade: RunTrade): boolean | null =>
  trade.with_movement ?? null

/** `con movimiento ×1,25` / `en calma ×0,75`; empty when the analyst did not rate this entry. */
function movementText(trade: RunTrade): string {
  const moving = movementOf(trade)
  if (moving === null) return ''
  const size = trade.size_mult ?? 1
  return `${moving ? 'con movimiento' : 'en calma'} ×${String(size).replace('.', ',')}`
}

const tradeLabel = (trade: RunTrade, index: number) =>
  `Operación ${index + 1} · ${trade.side === 'LONG' ? 'largo' : 'corto'} · ${WHEN.format(trade.entry_time_ms)} · ${signedAmount(trade.net_bp, 1)} pb${movementText(trade) ? ` · ${movementText(trade)}` : ''}`

type Props = {
  product: string
  candles: RunCandle[]
  /** `full` = the whole stretch of the test; `zoom` = the window around the chosen operation. */
  view: 'full' | 'zoom'
  trades: RunTrade[]
  selected: RunTrade | null
  onSelect: (trade: RunTrade) => void
  onShowAll: () => void
}

/**
 * One chart for the whole story: the real price of the product, each operation painted on it (green
 * won, red lost) and, when one is chosen, the same chart zooms to it and draws what could have been
 * earned. Under it, the two bars (what we made vs what was there) and the three icons of the right call.
 */
export default function MarketTradesChart({
  product,
  candles,
  view,
  trades,
  selected,
  onSelect,
  onShowAll,
}: Props) {
  const sorted = useMemo(
    () => [...trades].sort((a, b) => a.entry_time_ms - b.entry_time_ms),
    [trades],
  )
  const zoom = view === 'zoom' && selected !== null
  const pickedIndex = selected
    ? sorted.findIndex((t) => t.trade_id === selected.trade_id)
    : -1
  const closes = useMemo(
    () => candles.map((c) => [c.time_ms, Number(c.close)] as [number, number]),
    [candles],
  )
  const potential = useMemo(
    () =>
      selected && zoom
        ? tradePotential(candles, {
            entryMs: selected.entry_time_ms,
            exitMs: selected.exit_time_ms,
            entryPrice: priceOf(selected.entry_price),
          })
        : null,
    [candles, selected, zoom],
  )
  const notional = notionalOf(trades)
  // The legend of «con movimiento» / «en calma» only shows when the analyst rated the entries of this test
  const rated = trades.some((t) => movementOf(t) !== null)
  if (closes.length < 2)
    return (
      <p className="m-0 px-3 py-8 text-center text-body text-ink-2">
        Sin precios guardados para dibujar el mercado de esta prueba.
      </p>
    )

  const lo = closes[0]![0]
  const hi = closes[closes.length - 1]![0]
  const prices = closes.map((p) => p[1])
  const vLo = Math.min(...prices)
  const vHi = Math.max(...prices)
  const padY = zoom ? PAD_ZOOM_Y : PAD_Y
  const x = (t: number) =>
    PAD_X + (hi === lo ? 0.5 : (t - lo) / (hi - lo)) * (W - PAD_X - PAD_R)
  const y = (v: number) =>
    padY + (vHi === vLo ? 0.5 : (vHi - v) / (vHi - vLo)) * (H - 2 * padY)
  const path = (from: number, to: number) =>
    closes
      .filter(([t]) => t >= from && t <= to)
      .map(
        ([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)} ${y(v).toFixed(1)}`,
      )
      .join(' ')
  const priceAt = (ms: number) =>
    closes.reduce((best, p) =>
      Math.abs(p[0] - ms) < Math.abs(best[0] - ms) ? p : best,
    )[1]
  const lines = [0, 1, 2, 3, 4].map((k) => ({
    y: padY + ((H - 2 * padY) * k) / 4,
    value: vHi - ((vHi - vLo) * k) / 4,
  }))

  // What could have been earned is measured at size 1: it is weighted like the entry, so both bars compare the same bet
  const sizeMult = selected?.size_mult ?? 1
  const win = selected ? selected.net_bp >= 0 : true
  // The candles can be coarse (hourly closes): what could have been earned is never less than what was earned
  const couldEarn = Math.max(
    (potential?.best ?? 0) * sizeMult,
    win ? (selected?.net_bp ?? 0) : 0,
  )
  const long = selected?.side === 'LONG'
  const entryPrice = selected
    ? (priceOf(selected.entry_price) ?? priceAt(selected.entry_time_ms))
    : 0
  // The price comes into the entry from above or below: the label goes on the other side of the line.
  const priceBefore = selected
    ? priceAt(lo + (selected.entry_time_ms - lo) * 0.85)
    : 0
  const exitPrice = selected
    ? (priceOf(selected.exit_price) ?? priceAt(selected.exit_time_ms))
    : 0
  const best = Math.max(Math.abs(selected?.net_bp ?? 0), couldEarn, 20)
  const bar = (label: string, bp: number, tone: string, fill: string) => (
    <div className="grid gap-1 text-note">
      <div className="flex justify-between gap-2 text-ink-2">
        <span>{label}</span>
        <b className={`font-medium tabular-nums ${tone}`}>
          {money(bp, notional)} · {signedAmount(bp, 0)} pb
        </b>
      </div>
      <div className="h-3.5 rounded-sm bg-surface-2">
        <div
          className={`h-full rounded-sm ${fill}`}
          style={{ width: `${Math.max(3, (Math.abs(bp) / best) * 100)}%` }}
        />
      </div>
    </div>
  )
  const icon = (side: 1 | 0 | -1, label: string) => {
    const right = potential?.right === side
    const mine = (side === 1 && long) || (side === -1 && selected && !long)
    return (
      <div
        key={label}
        data-right={right ? 'true' : undefined}
        data-mine={mine ? 'true' : undefined}
        className={`relative grid justify-items-center gap-0.5 rounded-sm border border-solid px-1 py-2 text-hint ${right ? 'border-long bg-row-selected text-long' : 'border-line-strong text-ink-2'} ${mine ? 'border-dashed! border-ink!' : ''}`}
      >
        {mine && (
          <span className="absolute -top-2 left-1/2 -translate-x-1/2 bg-canvas px-1 text-label text-ink">
            hicimos
          </span>
        )}
        <svg viewBox="0 0 24 24" className="size-6" aria-hidden="true">
          {side === 1 && <path d="M12 4l9 15H3z" fill="currentColor" />}
          {side === -1 && <path d="M12 20L3 5h18z" fill="currentColor" />}
          {side === 0 && (
            <>
              <rect x="6" y="5" width="4" height="14" fill="currentColor" />
              <rect x="14" y="5" width="4" height="14" fill="currentColor" />
            </>
          )}
        </svg>
        {label}
      </div>
    )
  }
  const verdict =
    potential === null
      ? ''
      : potential.right === (long ? 1 : -1)
        ? 'Decisión correcta'
        : potential.right === 0
          ? 'No había que operar'
          : `Había que ir ${potential.right === 1 ? 'largo' : 'corto'}`

  return (
    <div className="grid min-w-0 gap-2.5" data-testid="market-chart">
      <div className="flex flex-wrap items-center justify-between gap-2 text-label tracking-section text-ink-2 uppercase">
        <span>
          {zoom && pickedIndex >= 0
            ? `Operación ${pickedIndex + 1} · mercado real de ${product.replace(/^PF_|USD$/g, '')}`
            : `${product.replace(/^PF_|USD$/g, '')} · mercado real y operaciones`}
        </span>
        <span className="flex items-center gap-3 tracking-normal normal-case">
          <span className="text-long">━ Ganó</span>
          <span className="text-short">━ Perdió</span>
          {rated && (
            <span className="text-ink-2" data-testid="movement-legend">
              <span className="text-ink">━ con movimiento</span> ·{' '}
              <span className="text-ink">┅ en calma</span>
            </span>
          )}
          {zoom && (
            <button
              type="button"
              onClick={onShowAll}
              className="cursor-pointer border-none bg-transparent p-0 text-hint text-info"
            >
              ← Ver todo el período
            </button>
          )}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Precio de ${product} con las operaciones de la prueba`}
        className="w-full"
      >
        {lines.map((line) => (
          <g key={line.y}>
            <line
              x1={PAD_X}
              x2={W - PAD_R + 6}
              y1={line.y}
              y2={line.y}
              className="stroke-line"
            />
            <text
              x={W - 2}
              y={line.y - 3}
              textAnchor="end"
              className="fill-ink-2 text-label"
            >
              {Math.round(line.value)} $
            </text>
          </g>
        ))}
        <path
          d={path(lo, hi)}
          fill="none"
          className="stroke-ink-3"
          strokeWidth={zoom ? 1.5 : 1.2}
        />
        {sorted.map((trade, index) => {
          if (trade.exit_time_ms < lo || trade.entry_time_ms > hi) return null
          const on = trade.trade_id === selected?.trade_id
          return (
            <path
              key={trade.trade_id}
              d={path(trade.entry_time_ms, trade.exit_time_ms)}
              fill="none"
              strokeWidth={on ? 5 : zoom ? 2 : 2.6}
              strokeDasharray={movementOf(trade) === false ? '5 4' : undefined}
              data-movement={
                movementOf(trade) === null
                  ? undefined
                  : movementOf(trade)
                    ? 'con-movimiento'
                    : 'en-calma'
              }
              opacity={zoom && !on ? 0.35 : 0.85}
              className={`cursor-pointer ${trade.net_bp >= 0 ? 'stroke-long' : 'stroke-short'}`}
              onClick={() => onSelect(trade)}
            >
              <title>{tradeLabel(trade, index)}</title>
            </path>
          )
        })}
        {zoom && selected && (
          <>
            <rect
              x={x(selected.entry_time_ms)}
              y={padY - 10}
              width={Math.max(
                2,
                x(selected.exit_time_ms) - x(selected.entry_time_ms),
              )}
              height={H - 2 * padY + 20}
              className={win ? 'fill-long' : 'fill-short'}
              opacity={0.07}
            />
            {potential && potential.bestAtMs !== null && (
              <>
                <line
                  x1={x(selected.entry_time_ms)}
                  y1={y(entryPrice)}
                  x2={x(potential.bestAtMs)}
                  y2={y(priceAt(potential.bestAtMs))}
                  className="stroke-info"
                  strokeWidth={3}
                  strokeDasharray="3 6"
                  strokeLinecap="round"
                  data-testid="potential-path"
                />
                <circle
                  cx={x(potential.bestAtMs)}
                  cy={y(priceAt(potential.bestAtMs))}
                  r={7}
                  className="fill-info"
                />
                <text
                  x={x(potential.bestAtMs)}
                  y={(() => {
                    // below the point for a short, above it for a long; never over the date axis
                    const at = y(priceAt(potential.bestAtMs!))
                    const below = at + 24
                    return potential.right === 1 || below > H - 24
                      ? at - 14
                      : below
                  })()}
                  textAnchor="middle"
                  className="fill-info text-hint stroke-canvas"
                  strokeWidth={4}
                  style={{ paintOrder: 'stroke' }}
                >
                  mejor salida
                </text>
              </>
            )}
            <line
              x1={x(selected.entry_time_ms)}
              x2={W - PAD_R}
              y1={y(entryPrice)}
              y2={y(entryPrice)}
              className="stroke-ink-2"
              strokeDasharray="2 4"
            />
            <circle
              cx={x(selected.entry_time_ms)}
              cy={y(entryPrice)}
              r={7}
              className="fill-ink"
            />
            <text
              x={x(selected.entry_time_ms) - 10}
              y={y(entryPrice) + (priceBefore > entryPrice ? 26 : -20)}
              textAnchor="end"
              className="fill-ink text-hint stroke-canvas"
              strokeWidth={4}
              style={{ paintOrder: 'stroke' }}
            >
              entrada {long ? 'LARGO' : 'CORTO'}
            </text>
            <circle
              cx={x(selected.exit_time_ms)}
              cy={y(exitPrice)}
              r={7}
              className={win ? 'fill-long' : 'fill-short'}
            />
            <text
              x={x(selected.exit_time_ms) + 10}
              y={y(exitPrice) + (exitPrice >= entryPrice ? -12 : 22)}
              className={`stroke-canvas text-hint ${win ? 'fill-long' : 'fill-short'}`}
              strokeWidth={4}
              style={{ paintOrder: 'stroke' }}
            >
              salida
            </text>
          </>
        )}
        {zoom && (
          <>
            {[0, 1, 2, 3, 4].map((k) => {
              const t = lo + ((hi - lo) * k) / 4
              return (
                <text
                  key={k}
                  x={x(t)}
                  y={H - 2}
                  textAnchor={k === 0 ? 'start' : k === 4 ? 'end' : 'middle'}
                  className="fill-ink-2 text-label"
                  data-testid="zoom-time"
                >
                  {WHEN.format(t)}
                </text>
              )
            })}
          </>
        )}
        {!zoom && (
          <>
            <text x={PAD_X + 2} y={H - 2} className="fill-ink-2 text-label">
              {DAY.format(lo)}
            </text>
            <text
              x={x(hi)}
              y={H - 2}
              textAnchor="end"
              className="fill-ink-2 text-label"
            >
              {DAY.format(hi)}
            </text>
          </>
        )}
      </svg>

      {sorted.length > 0 && (
        <div className="grid gap-1.5 rounded-lg bg-canvas px-3.5 py-3">
          <div className="flex justify-between gap-2 text-label tracking-section text-ink-2 uppercase">
            <span>Cada operación</span>
            <span className="tracking-normal normal-case">
              {rated
                ? 'ancho = tamaño · raya sólida = con movimiento · raya cortada = en calma · tocá una para ver qué pasó'
                : 'tocá una para ver qué pasó'}
            </span>
          </div>
          <div
            className="flex flex-wrap gap-0.75"
            role="group"
            aria-label="Cada operación"
          >
            {sorted.map((trade, index) => {
              const moving = movementOf(trade)
              return (
                <span
                  key={trade.trade_id}
                  className="grid content-end justify-items-center gap-0.5"
                >
                  <button
                    type="button"
                    aria-label={tradeLabel(trade, index)}
                    aria-pressed={trade.trade_id === selected?.trade_id}
                    onClick={() => onSelect(trade)}
                    data-movement={
                      moving === null
                        ? undefined
                        : moving
                          ? 'con-movimiento'
                          : 'en-calma'
                    }
                    style={{
                      height: 14 + Math.min(18, Math.abs(trade.net_bp) / 6),
                      // the width is the size the analyst gave the entry (12 px = size 1)
                      width: 12 * (trade.size_mult ?? 1),
                    }}
                    className={`cursor-pointer rounded-swatch border-none p-0 outline-offset-2 aria-pressed:outline-2 aria-pressed:outline-ink aria-pressed:outline-solid ${trade.net_bp >= 0 ? 'bg-long' : 'bg-short'}`}
                  />
                  {moving !== null && (
                    <span
                      aria-hidden="true"
                      className={`block w-full border-0 border-t-2 ${moving ? 'border-solid border-ink' : 'border-dashed border-ink-3'}`}
                    />
                  )}
                </span>
              )
            })}
          </div>
        </div>
      )}

      {zoom && selected && potential && (
        <div
          className="grid gap-3.5 rounded-lg border border-solid border-line-strong bg-canvas p-3.5"
          data-testid="trade-compare"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <strong className="text-body text-ink">
              Operación {pickedIndex + 1} · {long ? 'LARGO' : 'CORTO'}
              {movementText(selected) && (
                <span
                  className="font-normal text-ink-2"
                  data-testid="movement-note"
                >
                  {' '}
                  · entró {movementText(selected)}
                </span>
              )}
            </strong>
            <span
              className={`text-note font-semibold ${potential.right === (long ? 1 : -1) ? 'text-long' : 'text-warn'}`}
            >
              {verdict}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-4 run-stack:grid-cols-1">
            <div className="grid content-start gap-2.5">
              {bar(
                win ? 'Ganamos' : 'Perdimos',
                selected.net_bp,
                win ? 'text-long' : 'text-short',
                win ? 'bg-long' : 'bg-short',
              )}
              {bar('Se podía ganar', couldEarn, 'text-info', 'bg-info')}
            </div>
            <div
              className="grid grid-cols-3 gap-2"
              aria-label="Decisión correcta"
            >
              {icon(1, 'Largo')}
              {icon(0, 'Esperar')}
              {icon(-1, 'Corto')}
            </div>
          </div>
          <p className="m-0 text-hint text-ink-2">
            Verde: lo correcto. Borde punteado: lo que hicimos. Línea punteada
            azul: lo que se podía ganar, descontados los costos.
          </p>
        </div>
      )}
    </div>
  )
}
