import { existsSync, statSync } from 'node:fs'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { FUTURES_PRODUCT } from '../kraken-futures/futures-market.ts'
import { addDecimal, isDecimal, unrealizedPnl } from './decimal-string.ts'

type Row = Record<string, unknown>

export interface EngineEvent {
  readonly type: string
  readonly data: Row
}

/** Terminal engine block served while no account DB is configured. */
export const ENGINE_OFF = {
  status: 'off',
  reason: 'engine_not_running',
  funding: 'unresolved',
} as const

const ENGINE_COMMANDS = 'unavailable' // PS-06 adds the command channel to D.
const ANALYSES_KEPT = 100
const TAIL_WINDOW = 500
const ORDERS_KEPT = 500
const FILLS_KEPT = 500
const PAGE = 500
const MAX_PAGES = 10
const EQUITY_REFRESH_MS = 2_000
// D snapshots every 5 min of event time while it processes input: two missed
// snapshots (and no event) mean D is not running.
const DEFAULT_STALE_AFTER_MS = 600_000
const VERDICT_SCHEMA = 'futures-verdict.v1'
const ACCOUNT_KINDS = [
  'order_filled',
  'position_opened',
  'position_closed',
  'funding_accrued',
]

export interface PaperEngineFollowerOptions {
  /** Absent: the engine is reported `off` and nothing is read. */
  readonly accountDbPath?: string
  readonly verdictsDbPath?: string
  /**
   * Set when the services that feed the account and verdicts DBs cannot run
   * (dev found no Python): the engine is reported `unavailable` with this
   * reason and nothing is read.
   */
  readonly unavailableReason?: string
  readonly clock?: () => number
  /** Latest market mark as a decimal string, for equity at the mark. */
  readonly markPrice?: () => string | null
  readonly staleAfterMs?: number
}

interface Handle {
  readonly db: DatabaseSync
  readonly dev: number
  readonly ino: number
  readonly statements: Map<string, StatementSync>
}

function openReadOnly(path: string): Handle {
  const info = statSync(path)
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    db.exec('PRAGMA busy_timeout=2000;')
  } catch (error) {
    db.close()
    throw error
  }
  return { db, dev: info.dev, ino: info.ino, statements: new Map() }
}

function identityChanged(path: string, handle: Handle): boolean {
  try {
    const info = statSync(path)
    return info.dev !== handle.dev || info.ino !== handle.ino
  } catch {
    return true
  }
}

function prepare(handle: Handle, sql: string): StatementSync {
  let statement = handle.statements.get(sql)
  if (!statement) {
    statement = handle.db.prepare(sql)
    handle.statements.set(sql, statement)
  }
  return statement
}

function record(value: unknown): Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Row)
    : {}
}

function parseJson(text: unknown): Row | null {
  if (typeof text !== 'string') return null
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Row)
      : null
  } catch {
    return null
  }
}

type AccountBlock = Row

/** Open positions of an account block (one per independent book). */
function positionsOf(block: AccountBlock): Row[] {
  if (Array.isArray(block.positions))
    return block.positions.map((p) => record(p))
  return block.position ? [record(block.position)] : []
}

/**
 * Read-only follower of paper execution D's account DB and the verdicts DB,
 * projected into the terminal's existing `paper-futures-terminal-state.v1`
 * shape and stream events. It never writes and never scans history per tick:
 * it keeps a bounded in-memory view built from the tail of D's events (every
 * account-changing event carries the running totals) and the last verdicts,
 * then advances by `seq` / `bucket_start` primary-key ranges.
 */
export class PaperEngineFollower {
  private readonly accountPath: string | undefined
  private readonly verdictsPath: string | undefined
  private readonly clock: () => number
  private readonly markPrice: () => string | null
  private readonly staleAfterMs: number
  private account: Handle | undefined
  private verdicts: Handle | undefined
  private accountState: 'ready' | 'not_ready' | 'unreadable' = 'not_ready'
  private cursor = 0
  private lastEventTime: number | null = null
  private latestSnapshotTime: number | null = null
  private initialCash = '0'
  private block: AccountBlock | null = null
  /** Latest account block per independent book (key '' for a single-book account). */
  private readonly books = new Map<string, AccountBlock>()
  private orders = new Map<string, Row>()
  private pendingExitReasons = new Map<string, string>()
  private fills: Row[] = []
  private analyses: Row[] = []
  private verdictCursor = -1
  private everServed = false
  private pendingResync = false
  private servedStatusKey: string | null = null
  private lastEquityAt = Number.NEGATIVE_INFINITY
  private lastEquity: string | null = null

  private readonly forcedUnavailable: string | undefined

  constructor(options: PaperEngineFollowerOptions) {
    this.forcedUnavailable = options.unavailableReason
    this.accountPath = options.accountDbPath
    this.verdictsPath = options.verdictsDbPath
    this.clock = options.clock ?? Date.now
    this.markPrice = options.markPrice ?? (() => null)
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS
    if (this.reading) {
      this.ensureAccount()
      this.ensureVerdicts()
      this.servedStatusKey = this.statusKey()
    }
  }

  /** Whether the gateway reports an engine at all (not `off`). */
  get enabled(): boolean {
    return (
      this.accountPath !== undefined || this.forcedUnavailable !== undefined
    )
  }

  /** Whether the account and verdicts DBs are read. */
  private get reading(): boolean {
    return (
      this.forcedUnavailable === undefined && this.accountPath !== undefined
    )
  }

  close(): void {
    this.account?.db.close()
    this.verdicts?.db.close()
    this.account = undefined
    this.verdicts = undefined
  }

  // -- status -----------------------------------------------------------------

  private statusParts(): { status: string; reason: string | null } {
    if (this.forcedUnavailable !== undefined)
      return { status: 'unavailable', reason: this.forcedUnavailable }
    if (!this.enabled)
      return { status: ENGINE_OFF.status, reason: ENGINE_OFF.reason }
    if (this.accountState === 'unreadable')
      return { status: 'unavailable', reason: 'account_db_unreadable' }
    if (this.accountState === 'not_ready')
      return { status: 'starting', reason: 'account_db_not_ready' }
    const activity = Math.max(
      this.lastEventTime ?? Number.NEGATIVE_INFINITY,
      this.latestSnapshotTime ?? Number.NEGATIVE_INFINITY,
    )
    if (activity === Number.NEGATIVE_INFINITY)
      return { status: 'starting', reason: 'no_paper_execution_records_yet' }
    if (this.clock() - activity > this.staleAfterMs)
      return { status: 'idle', reason: 'no_recent_paper_execution_activity' }
    return { status: 'running', reason: 'paper_execution_active' }
  }

  private statusKey(): string {
    const { status, reason } = this.statusParts()
    return `${status}:${reason}`
  }

  /** Engine block for bootstrap, snapshot and `engine.status` events. */
  engineStatus(): Row {
    if (!this.enabled) return { ...ENGINE_OFF }
    this.servedStatusKey = this.statusKey()
    return this.statusBlock()
  }

  private statusBlock(): Row {
    const { status, reason } = this.statusParts()
    return {
      status,
      reason,
      source: 'paper-execution-d',
      commands: ENGINE_COMMANDS,
      observed_at_ms: this.clock(),
    }
  }

  // -- opening and rebuilding ---------------------------------------------------

  private ensureAccount(): void {
    const path = this.accountPath
    if (path === undefined) return
    if (this.account && identityChanged(path, this.account)) this.dropAccount()
    if (this.account) return
    if (!existsSync(path)) {
      this.accountState = 'not_ready'
      return
    }
    let handle: Handle | undefined
    try {
      handle = openReadOnly(path)
      const tables = prepare(
        handle,
        `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN
         ('paper_execution_events','paper_execution_snapshots','paper_execution_meta')`,
      ).get() as { n: number }
      if (tables.n < 3) {
        handle.db.close()
        this.accountState = 'not_ready'
        return
      }
      this.account = handle
      this.rebuild(handle)
      this.accountState = 'ready'
    } catch {
      handle?.db.close()
      this.account = undefined
      this.accountState = 'unreadable'
    }
  }

  private dropAccount(): void {
    this.account?.db.close()
    this.account = undefined
  }

  private ensureVerdicts(): void {
    const path = this.verdictsPath
    if (path === undefined) return
    if (this.verdicts && identityChanged(path, this.verdicts))
      this.dropVerdicts()
    if (this.verdicts || !existsSync(path)) return
    let handle: Handle | undefined
    try {
      handle = openReadOnly(path)
      const rows = prepare(
        handle,
        `SELECT payload_json FROM paper_futures_verdicts
         WHERE product_id=? ORDER BY bucket_start DESC LIMIT ${ANALYSES_KEPT}`,
      ).all(FUTURES_PRODUCT) as Array<{ payload_json: string }>
      this.verdicts = handle
      this.analyses = []
      this.verdictCursor = -1
      for (const row of rows.reverse()) this.takeVerdict(row.payload_json)
      if (this.everServed) this.pendingResync = true
    } catch {
      handle?.db.close()
      this.verdicts = undefined
    }
  }

  private dropVerdicts(): void {
    this.verdicts?.db.close()
    this.verdicts = undefined
  }

  /** Bounded rebuild from the tail window; the DB may have been replaced. */
  private rebuild(handle: Handle): void {
    this.orders = new Map()
    this.pendingExitReasons = new Map()
    this.fills = []
    this.block = null
    this.books.clear()
    this.lastEquity = null
    this.lastEquityAt = Number.NEGATIVE_INFINITY
    const head = Number(
      (
        prepare(
          handle,
          'SELECT COALESCE(MAX(seq), 0) AS head FROM paper_execution_events',
        ).get() as {
          head: number
        }
      ).head,
    )
    const meta = prepare(
      handle,
      "SELECT value FROM paper_execution_meta WHERE key='config_json'",
    ).get() as { value: string } | undefined
    const config = parseJson(meta?.value)
    const initial = config?.initial_cash_usd
    const bookCount = Array.isArray(config?.books) ? config.books.length : 1
    this.initialCash = isDecimal(initial)
      ? Array.from({ length: bookCount - 1 }).reduce<string>(
          (total) => addDecimal(total, initial) ?? total,
          initial,
        )
      : '0'
    const start = Math.max(0, head - TAIL_WINDOW)
    this.cursor = start
    this.lastEventTime = null
    const sink: EngineEvent[] = []
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const rows = this.readEvents(handle)
      for (const row of rows) this.applyEvent(row, sink, false)
      if (rows.length < PAGE) break
    }
    if (this.block === null) {
      const found = prepare(
        handle,
        `SELECT payload_json FROM paper_execution_events
         WHERE seq IN (
           SELECT MAX(seq) FROM paper_execution_events
           WHERE kind IN (${ACCOUNT_KINDS.map(() => '?').join(',')})
           GROUP BY json_extract(payload_json, '$.body.book'))
         ORDER BY seq`,
      ).all(...ACCOUNT_KINDS) as { payload_json: string }[]
      for (const row of found) {
        const body = record(parseJson(row.payload_json)?.body)
        const account = record(body.account)
        if (Object.keys(account).length > 0) {
          this.books.set(
            typeof body.book === 'string' ? body.book : '',
            account,
          )
          this.block = this.aggregate()
        }
      }
    }
    this.refreshSnapshotTime(handle)
    this.lastEquity = String(this.accountView().equity_usd)
    this.lastEquityAt = this.clock()
    if (this.everServed) this.pendingResync = true
  }

  private readEvents(handle: Handle): Row[] {
    const rows = prepare(
      handle,
      `SELECT seq, time_ms, kind, payload_json FROM paper_execution_events
       WHERE seq > ? ORDER BY seq LIMIT ${PAGE}`,
    ).all(this.cursor) as Row[]
    if (rows.length > 0) this.cursor = Number(rows.at(-1)!.seq)
    return rows
  }

  private refreshSnapshotTime(handle: Handle): void {
    const row = prepare(
      handle,
      'SELECT time_ms FROM paper_execution_snapshots ORDER BY seq DESC LIMIT 1',
    ).get() as { time_ms: number } | undefined
    this.latestSnapshotTime = row ? Number(row.time_ms) : null
  }

  // -- projection ------------------------------------------------------------------

  private accountView(): Row {
    const block = this.block
    const mark = this.markPrice()
    if (block === null)
      return {
        cash_usd: this.initialCash,
        equity_usd: this.initialCash,
        realized_gross_usd: '0',
        fees_usd: '0',
        funding_paid_usd: '0',
        funding_complete: true,
        net_usd: '0',
      }
    let unrealized: string | null = null
    if (mark)
      for (const open of positionsOf(block)) {
        const pnl = unrealizedPnl(
          open.side,
          open.quantity_btc,
          open.entry_price_usd_per_btc,
          mark,
        )
        unrealized = addDecimal(unrealized ?? '0', pnl ?? '0') ?? unrealized
      }
    const equity =
      addDecimal(block.cash_usd, unrealized ?? '0') ?? String(block.cash_usd)
    return {
      cash_usd: block.cash_usd,
      equity_usd: equity,
      realized_gross_usd: block.realized_gross_usd,
      fees_usd: block.fees_usd,
      funding_paid_usd: block.funding_paid_usd,
      funding_complete: block.funding_complete,
      net_usd: block.net_usd,
    }
  }

  private positionView(): Row | null {
    const position = this.block?.position
    return position ? { ...record(position) } : null
  }

  /** Every open position, one per independent book. */
  private positionsView(): Row[] {
    return this.block ? positionsOf(this.block).map((p) => ({ ...p })) : []
  }

  /** The one account the terminal shows: a single block as is, several summed. */
  private aggregate(): AccountBlock | null {
    const blocks = [...this.books.values()]
    if (blocks.length === 0) return null
    if (blocks.length === 1) {
      const only = blocks[0]!
      return { ...only, positions: positionsOf(only) }
    }
    const sum = (key: string): string => {
      let total = '0'
      for (const block of blocks)
        total = addDecimal(total, String(block[key] ?? '0')) ?? total
      return total
    }
    const positions = blocks.flatMap((block) => positionsOf(block))
    return {
      cash_usd: sum('cash_usd'),
      realized_gross_usd: sum('realized_gross_usd'),
      fees_usd: sum('fees_usd'),
      funding_paid_usd: sum('funding_paid_usd'),
      funding_complete: blocks.every((b) => b.funding_complete === true),
      net_usd: blocks.some((b) => b.net_usd === null || b.net_usd === undefined)
        ? null
        : sum('net_usd'),
      position: positions[0] ?? null,
      positions,
    }
  }

  /** Engine-owned fields of the terminal state; empty while the engine is off. */
  snapshotFields(): Row {
    if (!this.reading) return {}
    this.refresh()
    this.everServed = true
    this.servedStatusKey = this.statusKey()
    return {
      schema_version: 'paper-futures-terminal-state.v1',
      currency: 'USD',
      quantity_unit: 'BTC',
      account: this.accountView(),
      position: this.positionView(),
      positions: this.positionsView(),
      orders: [...this.orders.values()].slice(-100),
      fills: this.fills.slice(-100),
      analyses: [...this.analyses],
      ledger_events: [],
    }
  }

  private refresh(): void {
    this.ensureAccount()
    this.ensureVerdicts()
  }

  // -- event application -------------------------------------------------------------

  private setOrder(
    orderId: string,
    patch: Row,
    sink: EngineEvent[],
    emit: boolean,
  ): void {
    const next: Row = {
      ...(this.orders.get(orderId) ?? { order_id: orderId }),
      ...patch,
    }
    this.orders.delete(orderId)
    this.orders.set(orderId, next)
    if (this.orders.size > ORDERS_KEPT)
      this.orders.delete(this.orders.keys().next().value as string)
    if (emit) sink.push({ type: 'order.updated', data: { order: next } })
  }

  private applyEvent(row: Row, sink: EngineEvent[], emit: boolean): void {
    const time = Number(row.time_ms)
    const kind = String(row.kind)
    const seq = Number(row.seq)
    this.lastEventTime = time
    const body = record(parseJson(row.payload_json)?.body)
    const orderId = typeof body.order_id === 'string' ? body.order_id : null
    if (kind === 'exit_triggered' && orderId && typeof body.reason === 'string')
      this.pendingExitReasons.set(orderId, body.reason)
    else if (kind === 'order_created' && orderId) {
      const reason = this.pendingExitReasons.get(orderId)
      this.pendingExitReasons.delete(orderId)
      this.setOrder(
        orderId,
        {
          type: body.type,
          order_type: body.order_type ?? body.type,
          side: body.side,
          state: 'open',
          status: 'open',
          reduce_only: body.reduce_only === true,
          ...(body.quantity !== undefined
            ? { quantity_btc: body.quantity }
            : {}),
          ...(reason ? { reason_code: reason } : {}),
          ...(body.strategy_id !== undefined
            ? { strategy_id: body.strategy_id }
            : {}),
          ...(body.signal_key !== undefined
            ? { signal_key: body.signal_key }
            : {}),
          ...(body.stop !== undefined ? { stop: body.stop } : {}),
          ...(body.target !== undefined ? { target: body.target } : {}),
          decision_at_ms: time,
          eligible_at_ms: body.eligible_at_ms ?? null,
          expires_at_ms: body.expires_at_ms ?? null,
        },
        sink,
        emit,
      )
    } else if (
      (kind === 'order_rejected' || kind === 'order_expired') &&
      orderId
    )
      this.setOrder(
        orderId,
        {
          state: kind === 'order_rejected' ? 'rejected' : 'expired',
          status: kind === 'order_rejected' ? 'rejected' : 'expired',
          reason_code: body.reason ?? null,
          closed_at_ms: time,
        },
        sink,
        emit,
      )
    else if (kind === 'order_filled' && orderId) {
      this.setOrder(
        orderId,
        {
          side: body.side,
          state: 'filled',
          status: 'filled',
          quantity_btc: body.quantity,
          filled_quantity_btc: body.quantity,
          remaining_quantity_btc: '0',
          average_price_usd_per_btc: body.price,
          closed_at_ms: time,
        },
        sink,
        emit,
      )
      const fill: Row = {
        fill_id: `fill:${seq}`,
        order_id: orderId,
        side: body.side,
        quantity_btc: body.quantity,
        price_usd_per_btc: body.price,
        fee_usd: body.fee,
        liquidity: body.liquidity,
        reduce_only: body.reduce_only === true,
        event_time_ms: time,
      }
      this.fills.push(fill)
      if (this.fills.length > FILLS_KEPT)
        this.fills.splice(0, this.fills.length - FILLS_KEPT)
      if (emit) sink.push({ type: 'fill.created', data: { fill } })
    }
    const account = record(body.account)
    if (ACCOUNT_KINDS.includes(kind) && Object.keys(account).length > 0)
      this.applyAccount(
        account,
        typeof body.book === 'string' ? body.book : '',
        sink,
        emit,
      )
  }

  private applyAccount(
    incoming: AccountBlock,
    book: string,
    sink: EngineEvent[],
    emit: boolean,
  ): void {
    const previous = this.block
    const own = incoming.position
    this.books.set(
      book,
      own && book
        ? { ...incoming, position: { ...record(own), book } }
        : incoming,
    )
    const block = this.aggregate() as AccountBlock
    this.block = block
    if (!emit) return
    const positionChanged =
      JSON.stringify(previous?.position ?? null) !==
      JSON.stringify(block.position ?? null)
    const accountChanged =
      previous === null ||
      JSON.stringify({ ...previous, position: null }) !==
        JSON.stringify({ ...block, position: null })
    if (accountChanged || positionChanged) {
      const account = this.accountView()
      this.lastEquity = String(account.equity_usd)
      this.lastEquityAt = this.clock()
      sink.push({ type: 'account.updated', data: { account } })
    }
    if (positionChanged)
      sink.push({
        type: 'position.updated',
        data: {
          position: this.positionView(),
          positions: this.positionsView(),
        },
      })
  }

  private takeVerdict(payloadJson: string): Row | null {
    const verdict = parseJson(payloadJson)
    const bucket = Number(verdict?.bucket_start_ms)
    if (
      !verdict ||
      !Number.isSafeInteger(bucket) ||
      bucket <= this.verdictCursor
    )
      return null
    this.verdictCursor = bucket
    const analysis = toAnalysis(verdict)
    this.analyses.push(analysis)
    if (this.analyses.length > ANALYSES_KEPT)
      this.analyses.splice(0, this.analyses.length - ANALYSES_KEPT)
    return analysis
  }

  // -- polling --------------------------------------------------------------------------

  /**
   * Rows appended since the previous call as terminal events, in a fixed
   * order: a resync request, new verdict analyses, D's events in `seq` order,
   * an equity refresh at the mark, then an engine status change.
   */
  poll(): EngineEvent[] {
    if (!this.reading) return []
    const events: EngineEvent[] = []
    try {
      this.refresh()
      this.tailVerdicts(events)
      this.tailAccount(events)
      this.refreshEquity(events)
    } catch {
      this.dropAccount()
      this.accountState = 'unreadable'
    }
    const resync = this.pendingResync
    this.pendingResync = false
    this.everServed = true
    const key = this.statusKey()
    const changed = key !== this.servedStatusKey
    this.servedStatusKey = key
    if (resync)
      return [
        { type: 'resync.required', data: { reason: 'engine_state_rebuilt' } },
        ...(changed
          ? [{ type: 'engine.status', data: this.statusBlock() }]
          : []),
      ]
    if (changed)
      events.push({ type: 'engine.status', data: this.statusBlock() })
    return events
  }

  private tailVerdicts(events: EngineEvent[]): void {
    const handle = this.verdicts
    if (!handle) return
    try {
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const rows = prepare(
          handle,
          `SELECT payload_json FROM paper_futures_verdicts
           WHERE product_id=? AND bucket_start > ? ORDER BY bucket_start LIMIT 200`,
        ).all(FUTURES_PRODUCT, this.verdictCursor) as Array<{
          payload_json: string
        }>
        for (const row of rows) {
          const analysis = this.takeVerdict(row.payload_json)
          if (analysis)
            events.push({ type: 'analysis.completed', data: { analysis } })
        }
        if (rows.length < 200) break
      }
    } catch {
      this.dropVerdicts()
    }
  }

  private tailAccount(events: EngineEvent[]): void {
    const handle = this.account
    if (!handle) return
    const head = Number(
      (
        prepare(
          handle,
          'SELECT COALESCE(MAX(seq), 0) AS head FROM paper_execution_events',
        ).get() as {
          head: number
        }
      ).head,
    )
    if (head < this.cursor) {
      // Same file, fewer events: the chain was recreated in place.
      this.rebuild(handle)
      return
    }
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const rows = this.readEvents(handle)
      for (const row of rows) this.applyEvent(row, events, true)
      if (rows.length < PAGE) break
    }
    this.refreshSnapshotTime(handle)
  }

  private refreshEquity(events: EngineEvent[]): void {
    if (!this.block || positionsOf(this.block).length === 0) return
    const now = this.clock()
    if (now - this.lastEquityAt < EQUITY_REFRESH_MS) return
    const account = this.accountView()
    const equity = String(account.equity_usd)
    if (equity === this.lastEquity) return
    this.lastEquity = equity
    this.lastEquityAt = now
    events.push({ type: 'account.updated', data: { account } })
  }
}

/** Verdict payload -> terminal analysis (slim: conditions keep code and result). */
function toAnalysis(verdict: Row): Row {
  const selected = record(verdict.selected)
  const strategyId =
    typeof selected.strategy_id === 'string' ? selected.strategy_id : null
  const action = String(verdict.action ?? 'WAIT')
  const reasonCode = String(verdict.reason_code ?? selected.reason_code ?? '')
  const proposals = Array.isArray(verdict.proposals) ? verdict.proposals : []
  return {
    analysis_id: String(
      verdict.verdict_hash ?? `verdict:${verdict.bucket_start_ms}`,
    ),
    decision_time_ms: verdict.decision_known_at_ms,
    bucket_start_ms: verdict.bucket_start_ms,
    close_at_ms: verdict.close_at_ms,
    knowledge_lag_ms: verdict.knowledge_lag_ms,
    regime: verdict.regime,
    action,
    reason_code: reasonCode,
    selector: { action, strategy_id: strategyId, reason_code: reasonCode },
    selected_strategy_id: strategyId,
    runtime_version: VERDICT_SCHEMA,
    proposals: proposals.map((value) => {
      const proposal = record(value)
      const conditions = Array.isArray(proposal.conditions)
        ? proposal.conditions
        : []
      return {
        strategy_id: proposal.strategy_id,
        action: proposal.action,
        reason_code: proposal.reason_code,
        conditions: conditions.map((item) => ({
          code: record(item).code,
          passed: record(item).passed,
        })),
      }
    }),
  }
}
