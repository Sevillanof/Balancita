import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { amount, madridDateTime } from '../shared/finance/format.ts'
import {
  barScale,
  comparison,
  curveLines,
  curveSeries,
  exitReasonView,
  formatBalance,
  formatOneDecimal,
  formatPercent,
  formatSigned,
  holdShare,
  reviewPace,
  reviewSlots,
  type AccountStep,
  type QwenAccount,
} from './account-balance.ts'
import { useQwenAccount } from './useQwenAccount.ts'

const CURVE_W = 320
const CURVE_H = 72
const BARS_H = 64
const MAX_BARS = 60
/** Width of the tooltip, in px: `w-56`. */
const TIP_W = 224

const tone = (value: number) =>
  value > 0 ? 'text-long' : value < 0 ? 'text-short' : 'text-ink'

interface Tip {
  key: string
  content: ReactNode
  left: number
  top: number
  above: boolean
}

/** One tooltip for the whole panel, opened by hover or keyboard focus on an anchor. */
function useTip(panel: { current: HTMLDivElement | null }) {
  const [tip, setTip] = useState<Tip | null>(null)
  const tipId = useId()
  const anchor = (key: string, content: ReactNode, above = false) => {
    const show = (element: Element) => {
      const box = panel.current
      if (!box) return
      const at = element.getBoundingClientRect()
      const frame = box.getBoundingClientRect()
      const left = Math.min(
        Math.max(at.left - frame.left - TIP_W / 4, 8),
        Math.max(box.clientWidth - TIP_W - 8, 8),
      )
      const edge = above ? at.top : at.bottom
      setTip({
        key,
        content,
        left,
        top:
          edge - frame.top - box.clientTop + box.scrollTop + (above ? -6 : 6),
        above,
      })
    }
    return {
      'aria-describedby': tip?.key === key ? tipId : undefined,
      onMouseEnter: (event: { currentTarget: Element }) =>
        show(event.currentTarget),
      onFocus: (event: { currentTarget: Element }) => show(event.currentTarget),
      onMouseLeave: () => setTip(null),
      onBlur: () => setTip(null),
    }
  }
  const view = tip && (
    <div
      id={tipId}
      role="tooltip"
      data-testid="account-tip"
      style={{ left: tip.left, top: tip.top }}
      className={`pointer-events-none absolute z-10 w-56 rounded-control border border-solid border-line-strong bg-surface-2 p-2 text-label text-ink shadow-menu ${tip.above ? '-translate-y-full' : ''}`}
    >
      {tip.content}
    </div>
  )
  return { anchor, view }
}

const FOCUS =
  'cursor-default focus-visible:outline-2 focus-visible:outline-long focus-visible:outline-offset-2'

/** The card of one operation: side, net, time held against its cap, entry and exit (Madrid time) and prices, and why it closed. */
function OperationCard({ step }: { step: AccountStep }) {
  const held = holdShare(step)
  const reason = exitReasonView(step)
  const price = (value: number | null) => (value === null ? '—' : amount(value))
  return (
    <>
      <div className="flex items-center justify-between">
        <span
          data-testid="op-side"
          className={`rounded-badge px-1.5 text-badge font-bold ${step.side === 'LONG' ? 'bg-long/15 text-long' : 'bg-short/15 text-short'}`}
        >
          {step.side === 'LONG' ? '▲ LONG' : '▼ SHORT'}
        </span>
        <b
          data-testid="op-net"
          className={`font-semibold tabular-nums ${tone(step.netUsd)}`}
        >
          {formatSigned(step.netUsd)}
        </b>
      </div>
      {held && (
        <div className="mt-2 h-1 rounded-swatch bg-surface-1">
          <i
            data-testid="op-hold-fill"
            className="block h-full rounded-swatch bg-info"
            style={{ width: `${held.share * 100}%` }}
          />
        </div>
      )}
      <div className="mt-1 flex justify-between gap-1 text-ink-2 tabular-nums">
        <span>
          {step.entryMs === null ? '—' : madridDateTime(step.entryMs)}
        </span>
        {held && <span>{formatOneDecimal(held.hours)} h</span>}
        <span>{madridDateTime(step.exitMs)}</span>
      </div>
      <div className="mt-1 flex justify-between gap-1 text-ink-2 tabular-nums">
        <span>{price(step.entryPrice)}</span>
        {reason.text !== '' && (
          <span data-testid="op-reason" className="text-ink">
            {reason.icon ? `${reason.icon} ` : ''}
            {reason.text}
          </span>
        )}
        <span>{price(step.exitPrice)}</span>
      </div>
    </>
  )
}

function Swatch({
  dashed,
  className,
}: {
  dashed?: boolean
  className: string
}) {
  return (
    <svg viewBox="0 0 18 6" className="h-1.5 w-4.5 shrink-0" aria-hidden="true">
      <line
        x1="0"
        x2="18"
        y1="3"
        y2="3"
        strokeWidth="2"
        strokeDasharray={dashed ? '4 3' : undefined}
        className={className}
      />
    </svg>
  )
}

function BalancePanel({
  account,
  panelId,
  compact,
}: {
  account: QwenAccount
  panelId: string
  compact: boolean
}) {
  const panel = useRef<HTMLDivElement>(null)
  const { anchor, view } = useTip(panel)
  const steps = account.steps.slice(-MAX_BARS)
  const scale = barScale(steps)
  const gain = account.balanceUsd - account.startUsd
  const barW = CURVE_W / Math.max(steps.length, 1)
  const versus = comparison(account)
  const pace = reviewPace(account)
  const since =
    account.startMs === null ? '' : ` desde ${madridDateTime(account.startMs)}`
  const noEth = 'Sin dato del precio de ETH'
  const lines = curveLines(curveSeries(account), CURVE_W, CURVE_H)
  const terminalTip = (
    <>
      <p className="m-0">
        Terminal{since}: {formatBalance(versus.terminal.balance)} (
        {formatPercent(versus.terminal.pct)})
      </p>
      {account.openCount > 0 && (
        <p className="m-0 text-ink-2">
          Con la posición abierta: {formatSigned(account.openUsd)}
        </p>
      )}
      {account.fundingIncomplete && (
        <p className="m-0 text-ink-2">Funding todavía incompleto</p>
      )}
    </>
  )
  const ethTip = versus.eth ? (
    <p className="m-0">
      Tener ETH{since}: {formatBalance(versus.eth.balance)} (
      {formatPercent(versus.eth.pct)})
    </p>
  ) : (
    <p className="m-0">{noEth}</p>
  )
  const deltaTip =
    versus.delta === null ? (
      <p className="m-0">{noEth}</p>
    ) : (
      <p className="m-0">
        La Terminal va {formatBalance(Math.abs(versus.delta))}{' '}
        {versus.delta >= 0 ? 'mejor' : 'peor'} que tener ETH
      </p>
    )
  const reviewTip =
    pace.remaining === 0 ? (
      <p className="m-0">Revisión completa: {pace.done} operaciones</p>
    ) : (
      <p className="m-0">
        Faltan {pace.remaining}
        {pace.perDay !== null && pace.daysLeft !== null
          ? ` · ~${Math.ceil(pace.daysLeft - 1e-9)} días`
          : ''}
      </p>
    )
  const kpi = `flex items-center gap-1.5 rounded-control bg-surface-2 px-2 py-1.5 text-note font-semibold tabular-nums ${FOCUS}`
  return (
    <div
      ref={panel}
      id={panelId}
      role="dialog"
      aria-label="Saldo de la cuenta simulada"
      data-testid="account-balance-panel"
      className={`${compact ? 'fixed top-20 left-1/2 z-30 max-h-popover w-popover -translate-x-1/2 overflow-auto' : 'absolute top-full left-1/2 z-20 mt-2 w-balance -translate-x-1/2 header-stack:fixed header-stack:top-auto header-stack:inset-x-4 header-stack:left-4 header-stack:w-auto header-stack:translate-x-0'} rounded-panel border border-solid border-line-strong bg-surface-1 p-4 text-left shadow-lg`}
    >
      <div className="flex items-center gap-2">
        <div
          data-testid="account-kpi-terminal"
          tabIndex={0}
          className={kpi}
          {...anchor('terminal', terminalTip)}
        >
          <Swatch className={gain >= 0 ? 'stroke-long' : 'stroke-short'} />
          <span className={tone(versus.terminal.net)}>
            {formatSigned(versus.terminal.net)}
          </span>
        </div>
        <div
          data-testid="account-kpi-eth"
          tabIndex={0}
          className={kpi}
          {...anchor('eth', ethTip)}
        >
          <Swatch dashed className="stroke-info" />
          {versus.eth ? (
            <span className={tone(versus.eth.net)}>
              {formatSigned(versus.eth.net)}
            </span>
          ) : (
            <span className="text-ink-2">sin dato</span>
          )}
        </div>
        <div
          data-testid="account-kpi-delta"
          tabIndex={0}
          className={`${kpi} ml-auto ${versus.delta === null ? 'text-ink-2' : versus.delta >= 0 ? 'bg-long/15 text-long' : 'bg-short/15 text-short'}`}
          {...anchor('delta', deltaTip)}
        >
          {versus.delta === null ? (
            'sin dato'
          ) : (
            <>
              <span aria-hidden="true">{versus.delta >= 0 ? '▲' : '▼'}</span>
              <span>{formatSigned(versus.delta)}</span>
            </>
          )}
        </div>
      </div>
      {steps.length === 0 ? (
        <p role="status" className="m-0 mt-3 text-body">
          Todavía no hay operaciones cerradas.
        </p>
      ) : (
        <svg
          viewBox={`-2 -2 ${CURVE_W + 4} ${CURVE_H + 4}`}
          className="mt-3 block w-full"
          role="img"
          aria-label="Saldo de la Terminal (línea llena) contra tener ETH (línea punteada)"
          data-testid="account-curve"
        >
          {lines.eth.map((points) => (
            <polyline
              key={points}
              data-testid="account-curve-eth"
              points={points}
              fill="none"
              strokeWidth="1.8"
              strokeLinejoin="round"
              strokeDasharray="4 3"
              className="stroke-info"
            />
          ))}
          <polyline
            data-testid="account-curve-terminal"
            points={lines.terminal}
            fill="none"
            strokeWidth="1.8"
            strokeLinejoin="round"
            className={gain >= 0 ? 'stroke-long' : 'stroke-short'}
          />
        </svg>
      )}
      <div
        data-testid="account-review"
        tabIndex={0}
        aria-label={`${pace.done} de ${pace.target} operaciones${pace.perDay === null ? '' : `, ${formatOneDecimal(pace.perDay)} por día`}`}
        className={`mt-3 flex items-center gap-2 rounded-sm ${FOCUS}`}
        {...anchor('review', reviewTip)}
      >
        <div className="grid flex-1 grid-cols-30 gap-0.5" aria-hidden="true">
          {reviewSlots(account.steps).map((state, i) => (
            <i
              key={i}
              data-testid="review-slot"
              data-state={state}
              className={`h-2.5 rounded-swatch ${state === 'win' ? 'bg-long' : state === 'loss' ? 'bg-short' : 'bg-line-strong'}`}
            />
          ))}
        </div>
        <span
          data-testid="review-count"
          aria-hidden="true"
          className="rounded-full bg-surface-2 px-2 py-0.5 text-label whitespace-nowrap text-ink-2 tabular-nums"
        >
          {pace.done}/{pace.target}
        </span>
        <span
          data-testid="review-pace"
          aria-hidden="true"
          className="rounded-full bg-surface-2 px-2 py-0.5 text-label whitespace-nowrap text-ink-2 tabular-nums"
        >
          ⏱ {pace.perDay === null ? '—' : `${formatOneDecimal(pace.perDay)}/d`}
        </span>
      </div>
      {steps.length > 0 && (
        <svg
          viewBox={`0 0 ${CURVE_W} ${BARS_H}`}
          className="mt-3 block w-full"
          role="group"
          aria-label="Resultado de cada operación"
          data-testid="account-bars"
        >
          <line
            x1="0"
            x2={CURVE_W}
            y1={BARS_H / 2}
            y2={BARS_H / 2}
            className="stroke-line-strong"
            strokeWidth="0.6"
          />
          {steps.map((step, i) => {
            const win = step.netUsd >= 0
            const h = Math.max(scale[i]! * (BARS_H / 2 - 1), 1)
            return (
              <g
                key={`${step.product}-${step.tradeNo}`}
                data-testid={win ? 'bar-win' : 'bar-loss'}
                tabIndex={0}
                role="img"
                aria-label={`${step.side} ${formatSigned(step.netUsd)}`}
                className="group cursor-pointer outline-none focus-visible:outline-2 focus-visible:outline-long"
                {...anchor(
                  `bar-${step.product}-${step.tradeNo}`,
                  <OperationCard step={step} />,
                  true,
                )}
              >
                <rect
                  x={i * barW}
                  y={0}
                  width={barW}
                  height={BARS_H}
                  className="fill-transparent group-hover:fill-surface-hover group-focus-visible:fill-surface-hover"
                />
                <rect
                  x={i * barW + barW * 0.15}
                  width={barW * 0.7}
                  y={win ? BARS_H / 2 - h : BARS_H / 2}
                  height={h}
                  className={win ? 'fill-long' : 'fill-short'}
                />
              </g>
            )
          })}
        </svg>
      )}
      {view}
    </div>
  )
}

/** The simulated balance, as the number alone; the panel under it shows each operation. */
export function AccountBalanceView({
  account,
  compact = false,
}: {
  account: QwenAccount
  compact?: boolean
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const panelId = useId()
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    const onDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open])
  const gain = account.balanceUsd - account.startUsd
  const balanceTone =
    gain > 0 ? 'text-long' : gain < 0 ? 'text-short' : 'text-ink'
  return (
    <div
      ref={root}
      className={
        compact
          ? 'relative flex items-center gap-3 rounded-lg border border-solid border-line bg-surface-1 px-2 py-1 from-1100:gap-4 from-1100:px-3'
          : 'relative flex justify-center'
      }
    >
      <button
        type="button"
        data-testid="account-balance"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`Saldo de la cuenta simulada ${formatBalance(account.balanceUsd)}`}
        className={`${compact ? 'min-h-8 px-0 py-0 text-left text-brand-compact leading-none from-1100:text-run-title' : 'min-h-10 px-3 text-value'} cursor-pointer rounded-sm border border-solid border-transparent bg-transparent font-sans font-semibold tabular-nums hover:border-line-strong focus-visible:outline-2 focus-visible:outline-long focus-visible:outline-offset-2 ${compact ? 'text-ink' : balanceTone}`}
        onClick={() => setOpen((value) => !value)}
      >
        {compact && (
          <small className="block text-badge font-normal leading-tight text-ink-2">
            Valor actual
          </small>
        )}
        {formatBalance(account.balanceUsd)}
      </button>
      {compact && (
        <div className="text-left">
          <small className="block text-badge leading-tight text-ink-2">
            Realizado
          </small>
          <strong
            data-testid="account-realized"
            className="block text-label leading-tight text-ink from-1100:text-hint"
          >
            {formatBalance(account.startUsd + account.realizedUsd)}
          </strong>
        </div>
      )}
      {open && (
        <BalancePanel account={account} panelId={panelId} compact={compact} />
      )}
    </div>
  )
}

/** Header-center balance: renders nothing while the gateway has no account to show. */
export default function AccountBalance({
  compact = false,
}: {
  compact?: boolean
}) {
  const account = useQwenAccount()
  return account ? (
    <AccountBalanceView account={account} compact={compact} />
  ) : null
}
