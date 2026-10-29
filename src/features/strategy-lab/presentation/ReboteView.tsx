import { useMemo } from 'react'
import { amount } from '../../../shared/finance/format.ts'
import { count, signedAmount } from '../domain/strategy-format.ts'
import type {
  QuickRebote,
  ReboteAccount,
  ReboteVariant,
} from '../infrastructure/quick-api.ts'
import MarketTradesChart from './MarketTradesChart.tsx'
import type { ReboteModel, ReboteSize } from './rebote-model.ts'

const W = 900
const H = 170
const PAD_X = 10
const PAD_R = 56
const PAD_Y = 14

const WHEN = new Intl.DateTimeFormat('es-ES', {
  timeZone: 'Europe/Madrid',
  day: 'numeric',
  month: 'short',
  year: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
})
const YEAR = new Intl.DateTimeFormat('es-ES', {
  timeZone: 'Europe/Madrid',
  year: 'numeric',
})

// es-ES leaves 4-digit numbers without the thousands dot: an account of 1.000 USD needs it
const GROUPED = (digits: number) =>
  new Intl.NumberFormat('es-ES', {
    useGrouping: 'always',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
const MONEY = GROUPED(2)
const WHOLE = GROUPED(0)
const usd = (value: number) => `${MONEY.format(value)} USD`
const signedUsd = (value: number) => {
  const rounded = Number(value.toFixed(2))
  return `${rounded > 0 ? '+' : rounded < 0 ? '−' : ''}${MONEY.format(Math.abs(rounded))} USD`
}
const pct = (value: number) => `${signedAmount(value, 1) ?? '0,0'} %`

const SIZES: Array<{ id: ReboteSize; label: string; detail: string }> = [
  {
    id: 'compuesto',
    label: 'Toda la cuenta',
    detail:
      'La primera operación usa los 1.000 USD enteros; cada una siguiente, 1.000 más lo ganado o perdido hasta ahí. Sin apalancamiento.',
  },
  {
    id: 'fijo',
    label: '100 USD fijos',
    detail: 'El tamaño de paper: 100 USD en cada operación.',
  },
]

/** The account after each operation, from the start of the period: a dot per operation, green won and red lost. */
function AccountCurve({
  account,
  model,
  rebote,
}: {
  account: ReboteAccount
  model: ReboteModel
  rebote: QuickRebote
}) {
  const lo = rebote.desde_ms
  const hi = rebote.hasta_ms
  const points: Array<[number, number]> = [
    [lo, account.inicial_usd],
    ...account.curva,
  ]
  const values = points.map((p) => p[1])
  const vLo = Math.min(...values)
  const vHi = Math.max(...values)
  const x = (t: number) =>
    PAD_X + ((t - lo) / Math.max(hi - lo, 1)) * (W - PAD_X - PAD_R)
  const y = (v: number) =>
    PAD_Y + (vHi === vLo ? 0.5 : (vHi - v) / (vHi - vLo)) * (H - 2 * PAD_Y)
  // The account only changes when an operation closes: a step line
  const steps = points
    .map(([t, v], i) =>
      i === 0
        ? `M${x(t).toFixed(1)} ${y(v).toFixed(1)}`
        : `L${x(t).toFixed(1)} ${y(points[i - 1]![1]).toFixed(1)} L${x(t).toFixed(1)} ${y(v).toFixed(1)}`,
    )
    .join(' ')
  const base = y(account.inicial_usd)
  return (
    <div className="grid min-w-0 gap-1.5" data-testid="account-curve">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-label tracking-section text-ink-2 uppercase">
        <span>La cuenta, operación a operación</span>
        <span className="tracking-normal normal-case">
          empieza en {usd(account.inicial_usd)} · cada punto es una operación
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Curva de la cuenta"
        className="w-full"
      >
        <line
          x1={PAD_X}
          x2={W - PAD_R + 6}
          y1={base}
          y2={base}
          className="stroke-line-strong"
          strokeDasharray="3 4"
        />
        <text
          x={W - 2}
          y={base - 3}
          textAnchor="end"
          className="fill-ink-2 text-label"
        >
          {WHOLE.format(account.inicial_usd)} $
        </text>
        <text
          x={W - 2}
          y={y(vHi) + 10}
          textAnchor="end"
          className="fill-ink-2 text-label"
        >
          {WHOLE.format(vHi)} $
        </text>
        {vLo < account.inicial_usd && (
          <text
            x={W - 2}
            y={y(vLo) - 3}
            textAnchor="end"
            className="fill-ink-2 text-label"
          >
            {WHOLE.format(vLo)} $
          </text>
        )}
        <path
          d={steps}
          fill="none"
          className="stroke-ink-3"
          strokeWidth={1.4}
        />
        {model.trades.map((trade, i) => {
          const point = account.curva[i]
          if (!point) return null
          return (
            <circle
              key={trade.trade_id}
              cx={x(point[0])}
              cy={y(point[1])}
              r={trade.trade_id === model.selected?.trade_id ? 6 : 3.5}
              className={trade.net_bp >= 0 ? 'fill-long' : 'fill-short'}
              style={{ cursor: 'pointer' }}
              onClick={() => model.select(trade)}
            >
              <title>
                {`${WHEN.format(trade.exit_time_ms)} · ${usd(point[1])}`}
              </title>
            </circle>
          )
        })}
        <text x={PAD_X + 2} y={H - 2} className="fill-ink-2 text-label">
          {YEAR.format(lo)}
        </text>
        <text
          x={x(hi)}
          y={H - 2}
          textAnchor="end"
          className="fill-ink-2 text-label"
        >
          {YEAR.format(hi)}
        </text>
      </svg>
    </div>
  )
}

function VariantCard({
  variant,
  size,
  on,
  onPick,
}: {
  variant: ReboteVariant
  size: ReboteSize
  on: boolean
  onPick: () => void
}) {
  const account = variant.cuentas[size]
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onPick}
      data-testid={`rebote-variante-${variant.id}`}
      className={`grid cursor-pointer content-start gap-1 rounded-lg border border-solid bg-canvas px-3.5 py-3 text-left text-note text-ink ${on ? 'border-ink' : 'border-line'}`}
    >
      <strong className="text-body">{variant.label}</strong>
      <span className="text-ink-2">
        {count(variant.caidas)} caídas ·{' '}
        {variant.resumen.ganadoras != null
          ? `${amount(variant.resumen.ganadoras * 100, 0)} % ganan`
          : 'sin datos'}
        {' · '}caída máxima de la cuenta {amount(account.caida_maxima_pct, 1)} %
      </span>
      <span
        className={`tabular-nums ${account.ganancia_usd >= 0 ? 'text-long' : 'text-short'}`}
      >
        {usd(account.inicial_usd)} → {usd(account.final_usd)} (
        {pct(account.ganancia_pct)})
      </span>
    </button>
  )
}

type Props = {
  rebote: QuickRebote
  model: ReboteModel
}

/**
 * The rebound analyst's result: the account, the price of ETH with every fall that fires the rule, the entry after it and the
 * exit 24 h (or 4 h) later, and the list of falls. Everything is of the past; nothing here operates.
 */
export default function ReboteView({ rebote, model }: Props) {
  const { variant, size } = model
  const account = variant.cuentas[size]
  const years = useMemo(() => {
    const out = new Map<string, { n: number; usd: number }>()
    variant.operaciones.forEach((trade) => {
      const key = YEAR.format(trade.entrada_ms)
      const row = out.get(key) ?? { n: 0, usd: 0 }
      row.n += 1
      row.usd += trade.cuenta[size].pnl_usd
      out.set(key, row)
    })
    return [...out.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [variant, size])
  const wins = account.ganancia_usd >= 0
  const hold = `${amount(variant.salida_horas, 0)} h`
  return (
    <div className="grid min-w-0 gap-3" data-testid="rebote-view">
      <div className="grid gap-2 rounded-lg border border-solid border-line bg-canvas px-4 py-3.5">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
          <strong
            data-testid="rebote-total"
            className={`text-run-value leading-none tabular-nums ${wins ? 'text-long' : 'text-short'}`}
          >
            {signedUsd(account.ganancia_usd)}
          </strong>
          <div className="grid gap-0.5">
            <span className="text-title font-semibold text-ink">
              {usd(account.inicial_usd)} → {usd(account.final_usd)}
            </span>
            <span className="text-note text-ink-2">
              {count(variant.operaciones.length)} operaciones de ETH, largo y
              salida a las {hold} · {pct(account.ganancia_pct)} · la cuenta
              llegó a perder {amount(account.caida_maxima_pct, 1)} % desde su
              mejor momento
            </span>
          </div>
        </div>
        <p className="m-0 text-hint text-ink-2" data-testid="rebote-honesty">
          Es el pasado y la regla se eligió mirando este mismo período: no
          prueba que funcione de acá en adelante. Costos de{' '}
          {amount(rebote.costo_ida_vuelta_pb, 2)} pb de ida y vuelta, sin
          funding. No opera en paper.
        </p>
      </div>

      <div
        className="grid gap-2 rounded-lg border border-solid border-line bg-canvas px-3.5 py-3 text-note text-ink"
        data-testid="rebote-controles"
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="text-ink-2">Tamaño</span>
          <span
            role="radiogroup"
            aria-label="Tamaño de cada operación"
            className="flex flex-wrap gap-1.5"
          >
            {SIZES.map((option) => (
              <label
                key={option.id}
                className={`cursor-pointer rounded-sm border border-solid px-2.5 py-1 ${size === option.id ? 'border-ink bg-row-selected font-semibold text-ink' : 'border-line-strong text-ink-2'}`}
              >
                <input
                  type="radio"
                  name="rebote-tamano"
                  value={option.id}
                  checked={size === option.id}
                  onChange={() => model.setSize(option.id)}
                  className="sr-only"
                />
                {option.label}
              </label>
            ))}
          </span>
        </div>
        <span className="text-hint text-ink-2">
          {SIZES.find((option) => option.id === size)!.detail}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 run-stack:grid-cols-1">
        {rebote.variantes.map((v) => (
          <VariantCard
            key={v.id}
            variant={v}
            size={size}
            on={v.id === variant.id}
            onPick={() => model.setVariant(v.id)}
          />
        ))}
      </div>

      <MarketTradesChart
        product={model.product}
        candles={model.candles}
        view={model.selected ? 'zoom' : 'full'}
        trades={model.trades}
        selected={model.selected}
        onSelect={model.select}
        onShowAll={model.showAll}
      />

      <AccountCurve account={account} model={model} rebote={rebote} />

      <div className="grid gap-1.5" data-testid="rebote-caidas">
        <div className="text-label tracking-section text-ink-2 uppercase">
          Cada caída y su rebote
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-note tabular-nums">
            <thead>
              <tr className="text-left text-hint text-ink-2">
                <th className="py-1 pr-3 font-normal">Caída (Madrid)</th>
                <th className="py-1 pr-3 text-right font-normal">ETH en 1 h</th>
                {variant.filtro_btc_pct !== null && (
                  <th className="py-1 pr-3 text-right font-normal">BTC</th>
                )}
                <th className="py-1 pr-3 text-right font-normal">Entró</th>
                <th className="py-1 pr-3 text-right font-normal">Salió</th>
                <th className="py-1 pr-3 text-right font-normal">Resultado</th>
                <th className="py-1 text-right font-normal">Cuenta</th>
              </tr>
            </thead>
            <tbody>
              {model.trades.map((trade, i) => {
                const step = variant.operaciones[i]!.cuenta[size]
                const on = trade.trade_id === model.selected?.trade_id
                return (
                  <tr
                    key={trade.trade_id}
                    aria-selected={on}
                    className={`cursor-pointer border-0 border-t border-solid border-line ${on ? 'bg-row-selected' : ''}`}
                    onClick={() => model.select(trade)}
                  >
                    <td className="py-1 pr-3">
                      <button
                        type="button"
                        className="cursor-pointer border-none bg-transparent p-0 text-left text-note text-ink"
                        onClick={() => model.select(trade)}
                      >
                        {WHEN.format(trade.drop!.to_ms)}
                      </button>
                    </td>
                    <td className="py-1 pr-3 text-right text-warn">
                      {pct(trade.drop!.pct)}
                    </td>
                    {variant.filtro_btc_pct !== null && (
                      <td className="py-1 pr-3 text-right">
                        {trade.drop!.btc_pct === null
                          ? '—'
                          : pct(trade.drop!.btc_pct)}
                      </td>
                    )}
                    <td className="py-1 pr-3 text-right">
                      {amount(Number(trade.entry_price), 1)}
                    </td>
                    <td className="py-1 pr-3 text-right">
                      {amount(Number(trade.exit_price), 1)}
                    </td>
                    <td
                      className={`py-1 pr-3 text-right ${trade.net_bp >= 0 ? 'text-long' : 'text-short'}`}
                    >
                      {signedUsd(step.pnl_usd)} ({pct(trade.net_bp / 100)})
                    </td>
                    <td className="py-1 text-right">{usd(step.cuenta_usd)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid gap-1.5" data-testid="rebote-anios">
        <div className="text-label tracking-section text-ink-2 uppercase">
          Año por año
        </div>
        <div className="flex flex-wrap gap-2">
          {years.map(([year, row]) => (
            <span
              key={year}
              className="rounded-sm border border-solid border-line px-2.5 py-1 text-note tabular-nums"
            >
              {year} · {row.n} op. ·{' '}
              <b
                className={`font-medium ${row.usd >= 0 ? 'text-long' : 'text-short'}`}
              >
                {signedUsd(row.usd)}
              </b>
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
