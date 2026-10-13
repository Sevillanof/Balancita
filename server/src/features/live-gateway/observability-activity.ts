import { basename } from 'node:path'
import {
  expectedPairs,
  num,
  readRegistry,
  rowOf,
  withDb,
  type Expected,
  type Opened,
  type Row,
} from './observability-health.ts'

/**
 * `GET /api/observability/activity?window=3h|24h&product=`: what the pipeline
 * did in the window, counted from rows that already exist. Read-only: each
 * SQLite is opened `readOnly` + `query_only`, queried by primary-key ranges
 * bounded by the window and closed. Nothing is inferred: a source that cannot
 * be read is `unavailable` and says why; zero is only ever a count of rows that
 * were read, never a stand-in for «could not look».
 *
 * Activity is not health: a window without trades or signals is not an error
 * (the strategies may simply find nothing to do), so no field here is a status.
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE

export const ACTIVITY_WINDOWS = { '3h': 3 * HOUR, '24h': 24 * HOUR } as const
export type ActivityWindow = keyof typeof ACTIVITY_WINDOWS

/** Directional verdicts: the selected proposal is a LONG or a SHORT. */
const DIRECTIONAL = new Set(['LONG', 'SHORT'])
/** Cap of distinct reason codes returned (the verdict code set is small). */
const MAX_REASONS = 50

export interface ActivityEvidence {
  readonly source: string
  readonly origin: string | null
  readonly state: 'read' | 'missing' | 'unreadable'
  readonly detail?: string
  readonly rule: string
}

export interface ProductEvaluations {
  readonly product: string
  /** Verdict rows in the window (one per product and minute when healthy). */
  readonly count: number
  /** Minutes the window spans: what a continuous writer would have produced. */
  readonly expected: number
  /** `expected - count`, never negative: minutes without a verdict row. */
  readonly missing: number
  readonly first_bucket_ms: number | null
  readonly last_bucket_ms: number | null
  /** Moment the newest verdict's decision was known (ms epoch). */
  readonly last_known_at_ms: number | null
  readonly long: number
  readonly short: number
  readonly last_signal: {
    readonly bucket_ms: number
    readonly action: string
    readonly reason_code: string
  } | null
}

export interface ReasonCount {
  readonly reason_code: string
  readonly action: string
  readonly count: number
}

export interface ExperimentActivity {
  /** Strategy id of the forward (each one is an independent experiment). */
  readonly experiment_id: string
  /** The forward must be updating it now (registry/file); null: undetermined. */
  readonly expected_active: boolean | null
  readonly trades_in_window: number
  /** Positions open at this moment (forward_open payload present). */
  readonly open_positions: number
  readonly last_trade: {
    readonly product: string
    readonly side: string | null
    readonly entry_bucket_ms: number
    readonly exit_bucket_ms: number | null
    readonly exit_reason: string | null
  } | null
}

type Section<T> =
  | ({ readonly state: 'ok'; readonly evidence: ActivityEvidence } & T)
  | {
      readonly state: 'unavailable'
      readonly evidence: ActivityEvidence
      readonly detail: string
    }

export interface ObservabilityActivityReport {
  readonly generated_at_ms: number
  readonly cache_ttl_ms: number
  readonly window: ActivityWindow
  readonly from_ms: number
  /** Exclusive upper bound: the start of the current (unfinished) minute. */
  readonly to_ms: number
  readonly product: string | null
  readonly evaluations: Section<{
    readonly total: number
    readonly by_product: readonly ProductEvaluations[]
  }>
  readonly signals: Section<{
    readonly long: number
    readonly short: number
  }>
  readonly discards: Section<{
    readonly total: number
    readonly by_reason: readonly ReasonCount[]
    /** Discards the system does not persist today (B4), so cannot be counted. */
    readonly not_recorded: readonly string[]
  }>
  readonly operations: Section<{
    readonly pair_source: 'registro del forward' | 'estado del forward'
    readonly experiments: readonly ExperimentActivity[]
  }>
}

export interface ObservabilityActivityOptions {
  readonly products: readonly string[]
  readonly verdictsDbPath?: string
  readonly forwardDbPath?: string
  readonly strategiesDbPath?: string
  readonly forwardRegistrationPath?: string
  readonly strategySpecsDir?: string
  readonly forwardProducts?: readonly string[]
  readonly cacheMs?: number
  readonly clock?: () => number
}

export interface ObservabilityActivity {
  /** `undefined` product: all of them. Throws on an unknown product. */
  report(window: ActivityWindow, product?: string): ObservabilityActivityReport
}

export function isActivityWindow(value: unknown): value is ActivityWindow {
  return typeof value === 'string' && value in ACTIVITY_WINDOWS
}

function evidenceOf(
  source: string,
  path: string | undefined,
  opened: Opened<unknown>,
  rule: string,
): ActivityEvidence {
  return {
    source,
    origin: path ? basename(path) : null,
    state: opened.state,
    ...(opened.state !== 'read' ? { detail: opened.detail } : {}),
    rule,
  }
}

function unavailable(
  evidence: ActivityEvidence,
  detail: string,
): Section<Record<string, never>> {
  return { state: 'unavailable', evidence, detail }
}

interface VerdictRead {
  readonly byProduct: readonly ProductEvaluations[]
  readonly reasons: readonly ReasonCount[]
}

/**
 * One bounded range per product on the (product_id, bucket_start) primary key,
 * grouped by the two small columns that precede the payload: no payload JSON is
 * read or parsed, so the cost is the window's rows, not the table's history.
 */
function readVerdicts(
  options: ObservabilityActivityOptions,
  products: readonly string[],
  fromMs: number,
  toMs: number,
): Opened<VerdictRead> {
  return withDb(options.verdictsDbPath, (db) => {
    const expected = Math.round((toMs - fromMs) / MINUTE)
    const grouped = db.prepare(
      `SELECT action, reason_code, COUNT(*) AS n, MIN(bucket_start) AS first,
              MAX(bucket_start) AS last, MAX(decision_known_at) AS known
         FROM paper_futures_verdicts
        WHERE product_id = ? AND bucket_start >= ? AND bucket_start < ?
        GROUP BY action, reason_code`,
    )
    const lastSignal = db.prepare(
      `SELECT bucket_start AS bucket, action, reason_code
         FROM paper_futures_verdicts
        WHERE product_id = ? AND bucket_start >= ? AND bucket_start < ?
          AND action IN ('LONG', 'SHORT')
        ORDER BY bucket_start DESC LIMIT 1`,
    )
    const reasons = new Map<string, ReasonCount>()
    const byProduct: ProductEvaluations[] = []
    for (const product of products) {
      const rows = grouped.all(product, fromMs, toMs) as Row[]
      let count = 0
      let long = 0
      let short = 0
      let first: number | null = null
      let last: number | null = null
      let known: number | null = null
      for (const r of rows) {
        const n = num(r.n) ?? 0
        const action = String(r.action)
        count += n
        if (action === 'LONG') long += n
        if (action === 'SHORT') short += n
        const f = num(r.first)
        const l = num(r.last)
        const k = num(r.known)
        if (f !== null && (first === null || f < first)) first = f
        if (l !== null && (last === null || l > last)) last = l
        if (k !== null && (known === null || k > known)) known = k
        if (!DIRECTIONAL.has(action)) {
          const key = `${action}\u0000${String(r.reason_code)}`
          const prev = reasons.get(key)
          reasons.set(key, {
            reason_code: String(r.reason_code),
            action,
            count: (prev?.count ?? 0) + n,
          })
        }
      }
      const signal =
        long + short > 0 ? lastSignal.get(product, fromMs, toMs) : undefined
      const s = signal ? rowOf(signal) : null
      byProduct.push({
        product,
        count,
        expected,
        missing: Math.max(0, expected - count),
        first_bucket_ms: first,
        last_bucket_ms: last,
        last_known_at_ms: known,
        long,
        short,
        last_signal: s
          ? {
              bucket_ms: num(s.bucket) ?? 0,
              action: String(s.action),
              reason_code: String(s.reason_code),
            }
          : null,
      })
    }
    return {
      byProduct,
      reasons: [...reasons.values()]
        .sort(
          (a, b) =>
            b.count - a.count || a.reason_code.localeCompare(b.reason_code),
        )
        .slice(0, MAX_REASONS),
    }
  })
}

interface PairSet {
  readonly source: 'registro del forward' | 'estado del forward'
  readonly strategies: readonly { id: string; expected: boolean | null }[]
  readonly products: readonly string[]
}

/**
 * Experiments to report: the pairs the forward must run (same reconstruction as
 * the health report). If that cannot be determined, those the forward has a
 * status row for, marked `expected_active: null` so nobody reads them as «should
 * be running».
 */
function pairSet(
  options: ObservabilityActivityOptions,
  expected: Expected,
  statusStrategies: readonly string[],
  productFilter: string | null,
): PairSet {
  const forwardProducts = options.forwardProducts ?? options.products
  const filter = (list: readonly string[]) =>
    productFilter ? list.filter((p) => p === productFilter) : list
  if (expected.state === 'known') {
    const ids = new Set(expected.strategies.map((s) => s.id))
    return {
      source: 'registro del forward',
      strategies: [
        ...expected.strategies.map((s) => ({ id: s.id, expected: true })),
        // Seen by the forward but not required now: reported, not required.
        ...statusStrategies
          .filter((id) => !ids.has(id))
          .map((id) => ({ id, expected: false })),
      ],
      products: filter(expected.products),
    }
  }
  return {
    source: 'estado del forward',
    strategies: statusStrategies.map((id) => ({ id, expected: null })),
    products: filter(forwardProducts),
  }
}

function parseTrade(payload: unknown): Row {
  try {
    return rowOf(JSON.parse(String(payload)))
  } catch {
    return {}
  }
}

/**
 * Per (strategy, product): the newest trade by the primary-key prefix
 * (`ORDER BY entry_bucket_ms DESC LIMIT 1`), the window's trades by a bounded
 * range and the open position by key. Every lookup is O(log n) plus the
 * window, so the history of trades does not set the latency.
 */
function readOperations(
  options: ObservabilityActivityOptions,
  expected: Expected,
  productFilter: string | null,
  fromMs: number,
  toMs: number,
): Opened<{ set: PairSet; experiments: ExperimentActivity[] }> {
  return withDb(options.forwardDbPath, (db) => {
    const statusStrategies = (
      db
        .prepare(
          'SELECT DISTINCT strategy_id FROM forward_status ORDER BY strategy_id',
        )
        .all() as Row[]
    ).map((r) => String(r.strategy_id))
    const set = pairSet(options, expected, statusStrategies, productFilter)
    const newest = db.prepare(
      `SELECT entry_bucket_ms AS entry, payload FROM forward_trade
        WHERE strategy_id = ? AND product_id = ?
        ORDER BY entry_bucket_ms DESC LIMIT 1`,
    )
    const inWindow = db.prepare(
      `SELECT COUNT(*) AS n FROM forward_trade
        WHERE strategy_id = ? AND product_id = ?
          AND entry_bucket_ms >= ? AND entry_bucket_ms < ?`,
    )
    const openRow = db.prepare(
      'SELECT payload FROM forward_open WHERE strategy_id = ? AND product_id = ?',
    )
    const experiments: ExperimentActivity[] = []
    for (const strategy of set.strategies) {
      let trades = 0
      let open = 0
      let last: ExperimentActivity['last_trade'] = null
      for (const product of set.products) {
        trades +=
          num(rowOf(inWindow.get(strategy.id, product, fromMs, toMs)).n) ?? 0
        const o = openRow.get(strategy.id, product) as Row | undefined
        if (o && o.payload !== null && o.payload !== 'null') open += 1
        const row = newest.get(strategy.id, product) as Row | undefined
        const entry = row ? num(row.entry) : null
        if (
          row &&
          entry !== null &&
          (last === null || entry > last.entry_bucket_ms)
        ) {
          const t = parseTrade(row.payload)
          last = {
            product,
            side: typeof t.side === 'string' ? t.side : null,
            entry_bucket_ms: entry,
            exit_bucket_ms: num(t.exit_bucket_ms),
            exit_reason:
              typeof t.exit_reason === 'string' ? t.exit_reason : null,
          }
        }
      }
      experiments.push({
        experiment_id: strategy.id,
        expected_active: strategy.expected,
        trades_in_window: trades,
        open_positions: open,
        last_trade: last,
      })
    }
    return { set, experiments }
  })
}

export function createObservabilityActivity(
  options: ObservabilityActivityOptions,
): ObservabilityActivity {
  const clock = options.clock ?? Date.now
  const cacheMs = options.cacheMs ?? 15_000
  const cache = new Map<
    string,
    { at: number; value: ObservabilityActivityReport }
  >()
  return {
    report(window, product) {
      if (product !== undefined && !options.products.includes(product))
        throw new RangeError('invalid_product')
      const now = clock()
      const key = `${window}|${product ?? ''}`
      const hit = cache.get(key)
      if (hit && now - hit.at >= 0 && now - hit.at < cacheMs) return hit.value
      const span = ACTIVITY_WINDOWS[window]
      const toMs = now - (now % MINUTE)
      const fromMs = toMs - span
      const scope = product ? [product] : options.products

      const verdicts = readVerdicts(options, scope, fromMs, toMs)
      const verdictRule = `filas de paper_futures_verdicts con bucket_start en [${window} hasta el minuto en curso); una por producto y minuto si el servicio escribe sin pausas`
      const verdictEvidence = evidenceOf(
        'paper_futures_verdicts',
        options.verdictsDbPath,
        verdicts,
        verdictRule,
      )
      const none = (detail: string) =>
        unavailable(verdictEvidence, detail) as Section<never>

      const expected = expectedPairs(options, readRegistry(options))
      const operations = readOperations(
        options,
        expected,
        product ?? null,
        fromMs,
        toMs,
      )
      const opsEvidence = evidenceOf(
        'forward_trade / forward_open / forward_status',
        options.forwardDbPath,
        operations,
        'última operación por clave (estrategia, producto); operaciones de la ventana por rango de entry_bucket_ms; posición abierta por clave',
      )

      const value: ObservabilityActivityReport = {
        generated_at_ms: now,
        cache_ttl_ms: cacheMs,
        window,
        from_ms: fromMs,
        to_ms: toMs,
        product: product ?? null,
        evaluations:
          verdicts.state === 'read'
            ? {
                state: 'ok',
                evidence: verdictEvidence,
                total: verdicts.value.byProduct.reduce(
                  (a, p) => a + p.count,
                  0,
                ),
                by_product: verdicts.value.byProduct,
              }
            : none(verdicts.detail),
        signals:
          verdicts.state === 'read'
            ? {
                state: 'ok',
                evidence: {
                  ...verdictEvidence,
                  rule: 'veredictos cuya acción seleccionada es LONG o SHORT (propuesta direccional)',
                },
                long: verdicts.value.byProduct.reduce((a, p) => a + p.long, 0),
                short: verdicts.value.byProduct.reduce(
                  (a, p) => a + p.short,
                  0,
                ),
              }
            : none(verdicts.detail),
        discards:
          verdicts.state === 'read'
            ? {
                state: 'ok',
                evidence: {
                  ...verdictEvidence,
                  rule: 'veredictos cuya acción es WAIT o ABSTAIN, agrupados por reason_code',
                },
                total: verdicts.value.reasons.reduce((a, r) => a + r.count, 0),
                by_reason: verdicts.value.reasons,
                not_recorded: [
                  'entradas bloqueadas o descartadas por el forward (solo su recuento acumulado en forward_status)',
                  'fallos y esperas de Qwen',
                ],
              }
            : none(verdicts.detail),
        operations:
          operations.state === 'read'
            ? {
                state: 'ok',
                evidence: opsEvidence,
                pair_source: operations.value.set.source,
                experiments: operations.value.experiments,
              }
            : (unavailable(opsEvidence, operations.detail) as Section<never>),
      }
      cache.set(key, { at: now, value })
      return value
    },
  }
}
