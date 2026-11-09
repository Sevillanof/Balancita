import { record } from '../shared/wire/decode.ts'

/** One closed operation and the balance right after it; what the card on its bar shows is null when unknown. */
export interface AccountStep {
  product: string
  tradeNo: number
  side: 'LONG' | 'SHORT'
  exitMs: number
  netUsd: number
  balanceUsd: number
  entryMs: number | null
  entryPrice: number | null
  exitPrice: number | null
  closedBy: string | null
  exitReason: string | null
  /** The cap on how long the operation may stay open. */
  maxHoldMs: number | null
  /** ETH price (USD) when the operation closed; null when Kraken's data does not cover it. */
  ethPrice: number | null
}

export interface QwenAccount {
  startUsd: number
  /** When the account started; null when the gateway cannot say. */
  startMs: number | null
  /** The gateway's clock at the answer; the pace is measured up to it. */
  asOfMs: number | null
  balanceUsd: number
  realizedUsd: number
  openUsd: number
  openCount: number
  fundingIncomplete: boolean
  /** ETH price at the start of the account and now; null when unknown. */
  ethStartPrice: number | null
  ethNowPrice: number | null
  steps: AccountStep[]
}

/** Operations of the agreed review. */
export const REVIEW_TARGET = 30
/** The cap used on an operation that does not carry its own: 36 h. */
export const DEFAULT_MAX_HOLD_MS = 36 * 3_600_000
const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000

const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null
const positive = (value: unknown): number | null => {
  const out = finite(value)
  return out !== null && out > 0 ? out : null
}
const label = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null

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
        entryMs: finite(row.entry_ms),
        entryPrice: positive(row.entry_price),
        exitPrice: positive(row.exit_price),
        closedBy: label(row.closed_by),
        exitReason: label(row.exit_reason),
        maxHoldMs: positive(row.max_hold_ms),
        ethPrice: positive(row.eth_price),
      },
    ]
  })
  return {
    startUsd: start,
    startMs: finite(body.start_ms),
    asOfMs: finite(body.as_of_ms),
    balanceUsd: balance,
    realizedUsd: realized,
    openUsd: open,
    openCount: finite(body.open_count) ?? 0,
    fundingIncomplete: body.funding_incomplete === true,
    ethStartPrice: positive(body.eth_start_price),
    ethNowPrice: positive(body.eth_now_price),
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
const percent = new Intl.NumberFormat('es-ES', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
  signDisplay: 'exceptZero',
})
const oneDecimal = new Intl.NumberFormat('es-ES', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})

export const formatBalance = (value: number): string => usd.format(value)
export const formatSigned = (value: number): string => signed.format(value)
/** `+4,1 %`, `-2,0 %`, `0,0 %`. */
export const formatPercent = (value: number): string =>
  `${percent.format(value)} %`
/** One decimal, es-ES: operations per day (`2,7`), hours (`2,5`). */
export const formatOneDecimal = (value: number): string =>
  oneDecimal.format(value)

/**
 * What the capital would be worth if the ETH had been bought at the start and held:
 * `startUsd × price now / price at the start`. Null, never a guess, when either price
 * is missing or not a positive number.
 */
export function ethHoldUsd(
  startUsd: number,
  startPrice: number | null,
  price: number | null,
): number | null {
  if (
    startPrice === null ||
    price === null ||
    !Number.isFinite(startPrice) ||
    !Number.isFinite(price) ||
    startPrice <= 0 ||
    price <= 0
  )
    return null
  return (startUsd * price) / startPrice
}

/** The two lines of the chart, point by point: start, after each operation, now. ETH is null without its start price; a point is null when its price is unknown. */
export function curveSeries(account: QwenAccount): {
  terminal: number[]
  eth: Array<number | null> | null
} {
  const terminal = [
    account.startUsd,
    ...account.steps.map((s) => s.balanceUsd),
    account.balanceUsd,
  ]
  if (account.ethStartPrice === null) return { terminal, eth: null }
  const hold = (price: number | null) =>
    ethHoldUsd(account.startUsd, account.ethStartPrice, price)
  return {
    terminal,
    eth: [
      account.startUsd,
      ...account.steps.map((s) => hold(s.ethPrice)),
      hold(account.ethNowPrice),
    ],
  }
}

/** SVG points of both lines on one scale; the ETH line is split where a price is unknown, and a lone point draws nothing. */
export function curveLines(
  series: {
    terminal: readonly number[]
    eth: ReadonlyArray<number | null> | null
  },
  width: number,
  height: number,
): { terminal: string; eth: string[] } {
  const known = [...series.terminal, ...(series.eth ?? [])].filter(
    (v): v is number => v !== null,
  )
  const low = Math.min(...known)
  const span = Math.max(...known) - low
  const last = Math.max(series.terminal.length - 1, 1)
  const point = (v: number, i: number) =>
    `${((i / last) * width).toFixed(1)},${(span === 0 ? height / 2 : height - ((v - low) / span) * height).toFixed(1)}`
  const runs: string[][] = []
  let run: string[] = []
  ;(series.eth ?? []).forEach((v, i) => {
    if (v === null) {
      if (run.length > 0) runs.push(run)
      run = []
    } else run.push(point(v, i))
  })
  if (run.length > 0) runs.push(run)
  return {
    terminal: series.terminal.map(point).join(' '),
    eth: runs.filter((r) => r.length > 1).map((r) => r.join(' ')),
  }
}

interface Standing {
  balance: number
  net: number
  /** Percent of the starting capital. */
  pct: number
}

/** Terminal and «tener ETH» since the start, and Terminal minus ETH (positive: the Terminal is ahead). ETH and the difference are null without prices. */
export function comparison(account: QwenAccount): {
  terminal: Standing
  eth: Standing | null
  delta: number | null
} {
  const standing = (balance: number): Standing => ({
    balance,
    net: balance - account.startUsd,
    pct: ((balance - account.startUsd) / account.startUsd) * 100,
  })
  const terminal = standing(account.balanceUsd)
  const hold = ethHoldUsd(
    account.startUsd,
    account.ethStartPrice,
    account.ethNowPrice,
  )
  const eth = hold === null ? null : standing(hold)
  return { terminal, eth, delta: eth ? terminal.net - eth.net : null }
}

/** Operations done of the review, the pace per day since the start and the days it still needs. */
export function reviewPace(account: QwenAccount): {
  done: number
  target: number
  remaining: number
  /** Operations per day; the first day counts as a whole one so a few early trades do not inflate it. Null without a start. */
  perDay: number | null
  daysLeft: number | null
} {
  const done = account.steps.length
  const remaining = Math.max(REVIEW_TARGET - done, 0)
  const days =
    account.startMs === null || account.asOfMs === null
      ? null
      : Math.max((account.asOfMs - account.startMs) / DAY_MS, 1)
  const perDay = days === null ? null : done / days
  return {
    done,
    target: REVIEW_TARGET,
    remaining,
    perDay,
    daysLeft:
      remaining === 0
        ? 0
        : perDay === null || perDay <= 0
          ? null
          : remaining / perDay,
  }
}

/** The 30 slots of the review: one per closed operation, in order (green win, red loss), the rest empty. */
export function reviewSlots(
  steps: readonly AccountStep[],
): Array<'win' | 'loss' | 'empty'> {
  return Array.from({ length: REVIEW_TARGET }, (_, i) => {
    const step = steps[i]
    return step ? (step.netUsd >= 0 ? 'win' : 'loss') : 'empty'
  })
}

/** Hours the operation was open and the share of its cap (36 h when it has none), at most 1; null without an entry time. */
export function holdShare(
  step: AccountStep,
): { hours: number; share: number } | null {
  if (step.entryMs === null) return null
  const held = step.exitMs - step.entryMs
  return {
    hours: held / HOUR_MS,
    share: Math.min(
      Math.max(held / (step.maxHoldMs ?? DEFAULT_MAX_HOLD_MS), 0),
      1,
    ),
  }
}

const REASON_ICON: Record<string, { icon: string; text: string }> = {
  maestro_vuelta: { icon: '↺', text: 'vuelta' },
  maestro_agotado: { icon: '∅', text: 'agotado' },
}

/** Why the operation closed: an icon for the three usual reasons (vuelta, agotado, tiempo), the reason as text for the rest. */
export function exitReasonView(step: AccountStep): {
  icon: string | null
  text: string
} {
  if (step.closedBy === 'tiempo') return { icon: '⏲', text: 'tiempo' }
  const known = step.exitReason ? REASON_ICON[step.exitReason] : undefined
  if (known) return known
  const raw = step.exitReason ?? step.closedBy ?? ''
  return { icon: null, text: raw.replace(/_/g, ' ') }
}

/** Height (0..1) of the bar of each operation, against the biggest net in absolute value. */
export function barScale(steps: readonly AccountStep[]): number[] {
  const biggest = Math.max(...steps.map((s) => Math.abs(s.netUsd)), 0)
  return steps.map((s) => (biggest === 0 ? 0 : Math.abs(s.netUsd) / biggest))
}
