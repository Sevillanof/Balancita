import { useEffect, useId, useRef, useState } from 'react'
import { utcDateTime } from '../shared/finance/format.ts'
import {
  barScale,
  curvePoints,
  formatBalance,
  formatSigned,
  type QwenAccount,
} from './account-balance.ts'
import { useQwenAccount } from './useQwenAccount.ts'

const CURVE_W = 320
const CURVE_H = 72
const BARS_H = 64
const MAX_BARS = 60

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
  const steps = account.steps.slice(-MAX_BARS)
  const scale = barScale(steps)
  const gain = account.balanceUsd - account.startUsd
  const tone = gain > 0 ? 'text-long' : gain < 0 ? 'text-short' : 'text-ink'
  const barW = CURVE_W / Math.max(steps.length, 1)
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
        className={`${compact ? 'min-h-8 px-0 py-0 text-left text-brand-compact leading-none from-1100:text-run-title' : 'min-h-10 px-3 text-value'} cursor-pointer rounded-sm border border-solid border-transparent bg-transparent font-sans font-semibold tabular-nums hover:border-line-strong focus-visible:outline-2 focus-visible:outline-long focus-visible:outline-offset-2 ${compact ? 'text-ink' : tone}`}
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
        <div
          id={panelId}
          role="dialog"
          aria-label="Saldo de la cuenta simulada"
          data-testid="account-balance-panel"
          className={`${compact ? 'fixed top-20 left-1/2 z-30 max-h-popover w-popover -translate-x-1/2 overflow-auto' : 'absolute top-full left-1/2 z-20 mt-2 w-balance -translate-x-1/2 header-stack:fixed header-stack:top-auto header-stack:inset-x-4 header-stack:left-4 header-stack:w-auto header-stack:translate-x-0'} rounded-panel border border-solid border-line-strong bg-surface-1 p-4 text-left shadow-lg`}
        >
          <p className="m-0 text-hint text-ink-2">Cuenta simulada (paper)</p>
          <p className="m-0 mb-3 text-hint text-ink-2">
            Desde {formatBalance(account.startUsd)}:{' '}
            <span className={tone}>{formatSigned(gain)}</span>
          </p>
          {steps.length === 0 ? (
            <p role="status" className="m-0 text-body">
              Todavía no hay operaciones cerradas.
            </p>
          ) : (
            <>
              <p className="m-0 mb-1 text-hint text-ink-2">
                Saldo después de cada operación
              </p>
              <svg
                viewBox={`-2 -2 ${CURVE_W + 4} ${CURVE_H + 4}`}
                className="block w-full"
                role="img"
                aria-label="Curva del saldo"
                data-testid="account-curve"
              >
                <polyline
                  points={curvePoints(account, CURVE_W, CURVE_H)}
                  fill="none"
                  strokeWidth="1.8"
                  strokeLinejoin="round"
                  className={`${gain >= 0 ? 'stroke-long' : 'stroke-short'}`}
                />
              </svg>
              <p className="m-0 mt-3 mb-1 text-hint text-ink-2">
                Ganó (verde) o perdió (rojo) cada operación
              </p>
              <svg
                viewBox={`0 0 ${CURVE_W} ${BARS_H}`}
                className="block w-full"
                role="img"
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
                  const h = Math.max(scale[i]! * (BARS_H / 2 - 1), 1)
                  return (
                    <rect
                      key={`${step.product}-${step.tradeNo}`}
                      data-testid={step.netUsd >= 0 ? 'bar-win' : 'bar-loss'}
                      x={i * barW + barW * 0.15}
                      width={barW * 0.7}
                      y={step.netUsd >= 0 ? BARS_H / 2 - h : BARS_H / 2}
                      height={h}
                      className={step.netUsd >= 0 ? 'fill-long' : 'fill-short'}
                    >
                      <title>
                        {`${step.side === 'LONG' ? 'Larga' : 'Corta'} · ${utcDateTime(step.exitMs)} · ${formatSigned(step.netUsd)} → saldo ${formatBalance(step.balanceUsd)}`}
                      </title>
                    </rect>
                  )
                })}
              </svg>
            </>
          )}
          <p className="m-0 mt-3 text-hint text-ink-2">
            Saldo = capital inicial + resultado neto de las operaciones cerradas
            (con comisiones y funding)
            {account.openCount > 0
              ? `, más lo que rinde ahora la posición abierta (${formatSigned(account.openUsd)}, si se cerrara ya)`
              : ''}
            .
            {account.fundingIncomplete
              ? ' Hay operaciones con funding todavía incompleto.'
              : ''}
          </p>
        </div>
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
