import { record } from '../shared/wire/decode.ts'

/** One closed operation and the balance right after it. */
export interface AccountStep {
  product: string
  tradeNo: number
  side: 'LONG' | 'SHORT'
  exitMs: number
  netUsd: number
  balanceUsd: number
}

export interface QwenAccount {
  startUsd: number
  balanceUsd: number
  realizedUsd: number
  openUsd: number
  openCount: number
  fundingIncomplete: boolean
  steps: AccountStep[]
}

const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

/** The account of a `/api/qwen/account` answer; null when it is off or malformed. */
export function qwenAccount(payload: unknown): QwenAccount | null {
  const body = record(payload)
  const start = finite(body.start_usd)
  const balance = finite(body.balance_usd)
  const realized = finite(body.realized_usd)
  const open = finite(body.open_usd)
  if (
    body.status !== 'ok' ||
    start === null ||
    balance === null ||
    realized === null ||
    open === null ||
    !Array.isArray(body.steps)
  )
    return null
  const steps = body.steps.map(record).flatMap((row): AccountStep[] => {
    const exitMs = finite(row.exit_ms)
    const net = finite(row.net_usd)
    const after = finite(row.balance_usd)
    const tradeNo = finite(row.trade_no)
    if (
      exitMs === null ||
      net === null ||
      after === null ||
      tradeNo === null ||
      typeof row.product !== 'string' ||
      (row.side !== 'LONG' && row.side !== 'SHORT')
    )
      return []
    return [
      {
        product: row.product,
        tradeNo,
        side: row.side,
        exitMs,
        netUsd: net,
        balanceUsd: after,
      },
    ]
  })
  return {
    startUsd: start,
    balanceUsd: balance,
    realizedUsd: realized,
    openUsd: open,
    openCount: finite(body.open_count) ?? 0,
    fundingIncomplete: body.funding_incomplete === true,
    steps,
  }
}

const usd = new Intl.NumberFormat('es-ES', {
  style: 'currency',
  currency: 'USD',
  currencyDisplay: 'narrowSymbol',
})
const signed = new Intl.NumberFormat('es-ES', {
  style: 'currency',
  currency: 'USD',
  currencyDisplay: 'narrowSymbol',
  signDisplay: 'always',
})

export const formatBalance = (value: number): string => usd.format(value)
export const formatSigned = (value: number): string => signed.format(value)

/** Points of the balance curve: the start, then the balance after each operation. */
export function curvePoints(
  account: QwenAccount,
  width: number,
  height: number,
): string {
  const values = [account.startUsd, ...account.steps.map((s) => s.balanceUsd)]
  if (account.openCount > 0) values.push(account.balanceUsd)
  const low = Math.min(...values)
  const high = Math.max(...values)
  const span = high - low || 1
  const last = Math.max(values.length - 1, 1)
  return values
    .map(
      (v, i) =>
        `${((i / last) * width).toFixed(1)},${(height - ((v - low) / span) * height).toFixed(1)}`,
    )
    .join(' ')
}

/** Height (0..1) of the bar of each operation, against the biggest net in absolute value. */
export function barScale(steps: readonly AccountStep[]): number[] {
  const biggest = Math.max(...steps.map((s) => Math.abs(s.netUsd)), 0)
  return steps.map((s) => (biggest === 0 ? 0 : Math.abs(s.netUsd) / biggest))
}
