import {
  closeSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * `GET /api/observability/health` (Mission Control B1): the state of six
 * components of the system, each derived only from evidence that can be read
 * now (SQLite opened read-only, the supervisor's health file, the summaries
 * the experiments write). Nothing here writes, spawns or polls: a report is
 * computed on request and reused for `cacheMs`.
 *
 * Rules the code enforces (docs/observabilidad-salud-api.md has the contract):
 * - A status is `ok` only when every required check found evidence that it is
 *   fine. A missing source is `unknown`, never `ok`; no error is not health.
 * - A process that is running is not evidence that it produces anything: its
 *   output (a row, a candle, a summary) must be recent too.
 * - The overall status is `ok` only when all six components are `ok`.
 */
export type HealthStatus = 'ok' | 'warning' | 'error' | 'unknown'

export interface HealthCheck {
  readonly id: string
  readonly label: string
  readonly status: HealthStatus
  /** A required check that is `unknown` keeps its component from being `ok`. */
  readonly required: boolean
  /** The measured value (age in ms, count, process state), null when unknown. */
  readonly value: number | string | null
  /** The rule applied, with the thresholds used. */
  readonly rule: string
  readonly detail: string
}

export interface HealthEvidence {
  /** What was read (table, file or field). */
  readonly source: string
  /** File the evidence comes from (base name only), null when none was read. */
  readonly origin: string | null
  /** Newest timestamp the evidence itself carries, null when unknown. */
  readonly last_updated_ms: number | null
  /** `read`: found now. `missing`: not configured or file absent. `unreadable`. */
  readonly state: 'read' | 'missing' | 'unreadable'
  readonly detail?: string
}

export interface HealthComponent {
  readonly id:
    'data' | 'processing' | 'strategies' | 'decisions' | 'paper' | 'risk'
  readonly label: string
  readonly status: HealthStatus
  readonly summary: string
  readonly checks: readonly HealthCheck[]
  readonly evidence: readonly HealthEvidence[]
  /** Per product / strategy / experiment detail, when the component has any. */
  readonly items?: readonly Record<string, unknown>[]
  readonly limitations: readonly string[]
}

export interface ObservabilityHealthReport {
  readonly schema: 'observability-health.v1'
  readonly generated_at_ms: number
  readonly cache_ms: number
  readonly overall: {
    readonly status: HealthStatus
    readonly reason: string
    readonly failing: readonly HealthComponent['id'][]
    readonly unverified: readonly HealthComponent['id'][]
  }
  readonly components: readonly HealthComponent[]
}

export interface ObservabilityHealthOptions {
  readonly products: readonly string[]
  readonly marketDbPath?: string
  readonly verdictsDbPath?: string
  readonly decisionsDbPath?: string
  readonly forwardDbPath?: string
  readonly strategiesDbPath?: string
  /** `config/forward-strategies.json`: what the forward runner measures besides the registry. */
  readonly forwardRegistrationPath?: string
  /** `config/strategies/`: the specs the forward can run for file-registered strategies. */
  readonly strategySpecsDir?: string
  /** Products the forward runner iterates (`FUTURES_PRODUCTS` or the pinned list); default: `products`. */
  readonly forwardProducts?: readonly string[]
  readonly processHealthPath?: string
  readonly qwenExitSummaryPath?: string
  /** C31 switched off by the owner (`off` block of config/qwen-exit.json): shown as "apagada" with this reason. */
  readonly qwenExitOff?: { readonly reason: string; readonly since: string }
  readonly kronosSummaryPath?: string
  readonly resilienceLogPath?: string
  /** The capture's own stale limit (`MARKET_STALE_AFTER_MS`, default 15 s). */
  readonly staleAfterMs?: number
  readonly cacheMs?: number
  readonly clock?: () => number
}

export interface ObservabilityHealth {
  report(): ObservabilityHealthReport
}

export type Row = Record<string, unknown>
type ProcessState = 'running' | 'restarting' | 'down' | 'absent' | 'unknown'

// Cadences these thresholds come from (see docs/observabilidad-salud-api.md).
const SECOND = 1_000
const MINUTE = 60_000
/** Capture polls the REST ticker every second (capture-main `tickerPollMs`). */
const TICKER_WARN_FACTOR = 4
/** Official 1 m candles are polled 3 s after each minute (live-capture). */
const CANDLE_OK_MS = 2 * MINUTE
const CANDLE_ERROR_MS = 5 * MINUTE
/** Verdicts are written once per product and minute by the verdict service. */
const VERDICT_OK_MS = 3 * MINUTE
const VERDICT_ERROR_MS = 10 * MINUTE
/** Forward and C31 loop every 1800 s (dev-provider-env). */
const FORWARD_LOOP_MS = 30 * MINUTE
const FORWARD_OK_MS = 1.5 * FORWARD_LOOP_MS
const FORWARD_ERROR_MS = 2 * FORWARD_LOOP_MS
/** Kronos loops every 3600 s (docs/kronos-supervision.md). */
const KRONOS_LOOP_MS = 60 * MINUTE
/** The supervisor rewrites its health file every 5 s (scripts/dev.mjs). */
const SUPERVISOR_OK_MS = 30 * SECOND
const GAP_RECENT_MS = 60 * MINUTE
const GAP_WINDOW_MS = 24 * 60 * MINUTE
const TICKER_WINDOW_MS = 10 * MINUTE
const VERDICT_WINDOW_MS = 10 * MINUTE
const LAG_WARN_MS = 10 * MINUTE
const LOG_TAIL_BYTES = 64 * 1024

/** The pipeline's own processes when the supervisor launched them. */
const CORE_PROCESSES = [
  'capture',
  'live',
  'verdict',
  'scores',
  'forward',
  'strategies',
] as const

const RANK: Record<HealthStatus, number> = {
  ok: 0,
  unknown: 1,
  warning: 2,
  error: 3,
}

function worst(statuses: readonly HealthStatus[]): HealthStatus {
  return statuses.reduce<HealthStatus>(
    (acc, status) => (RANK[status] > RANK[acc] ? status : acc),
    'ok',
  )
}

export function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function rowOf(value: unknown): Row {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Row)
    : {}
}

function fileMtimeMs(path: string | undefined): number | null {
  if (!path) return null
  try {
    return Math.round(statSync(path).mtimeMs)
  } catch {
    return null
  }
}

function readJson(path: string | undefined): Row | null {
  if (!path) return null
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return value && typeof value === 'object' ? (value as Row) : null
  } catch {
    return null
  }
}

export type Opened<T> =
  | { readonly state: 'read'; readonly value: T }
  | { readonly state: 'missing' | 'unreadable'; readonly detail: string }

/** One short-lived read-only connection: opened, queried and closed here. */
export function withDb<T>(
  path: string | undefined,
  read: (db: DatabaseSync) => T,
): Opened<T> {
  if (!path) return { state: 'missing', detail: 'source_not_configured' }
  if (fileMtimeMs(path) === null)
    return { state: 'missing', detail: 'file_not_found' }
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(path, { readOnly: true })
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=250')
    return { state: 'read', value: read(db) }
  } catch (error) {
    return {
      state: 'unreadable',
      detail: error instanceof Error ? error.message.slice(0, 160) : 'error',
    }
  } finally {
    try {
      db?.close()
    } catch {
      // Closing a read-only handle must not turn a report into an error.
    }
  }
}

function evidenceOf(
  source: string,
  path: string | undefined,
  opened: Opened<unknown>,
  lastUpdated: number | null,
  detail?: string,
): HealthEvidence {
  return {
    source,
    origin: path ? basename(path) : null,
    last_updated_ms: opened.state === 'read' ? lastUpdated : null,
    state: opened.state === 'read' ? 'read' : opened.state,
    ...(opened.state !== 'read'
      ? { detail: opened.detail }
      : detail
        ? { detail }
        : {}),
  }
}

function check(
  fields: Omit<HealthCheck, 'required'> & { required?: boolean },
): HealthCheck {
  return { required: true, ...fields }
}

/** Status of one product's age against `ok` and `error` limits (warning between). */
function ageStatus(
  age: number | null,
  okMs: number,
  errorMs: number,
): HealthStatus {
  if (age === null) return 'unknown'
  if (age <= okMs) return 'ok'
  return age <= errorMs ? 'warning' : 'error'
}

/**
 * Process alive vs. producing. Fresh output is the only proof of work; a
 * running process with stale or no output is an error, not a pass. Without
 * supervisor information a stale output is `unknown` unless the process is
 * `mandatory` (the system cannot be fine without it).
 */
function pairStatus(
  process: ProcessState,
  outputAge: number | null,
  okMs: number,
  errorMs: number,
  mandatory: boolean,
): { status: HealthStatus; reason: string } {
  const output = ageStatus(outputAge, okMs, errorMs)
  if (output === 'ok')
    return process === 'down'
      ? { status: 'warning', reason: 'output_fresh_but_supervisor_says_down' }
      : { status: 'ok', reason: 'producing' }
  if (process === 'running')
    return {
      status: 'error',
      reason:
        outputAge === null
          ? 'process_active_without_output'
          : 'process_active_output_stale',
    }
  if (process === 'restarting')
    return { status: 'warning', reason: 'process_restarting' }
  if (process === 'down') return { status: 'error', reason: 'process_down' }
  if (outputAge === null)
    return {
      status: mandatory ? 'error' : 'unknown',
      reason: mandatory ? 'no_output_found' : 'no_output_and_no_process_info',
    }
  return {
    status: mandatory ? output : 'unknown',
    reason: mandatory ? 'output_stale' : 'output_stale_and_no_process_info',
  }
}

function makeComponent(
  id: HealthComponent['id'],
  label: string,
  checks: readonly HealthCheck[],
  evidence: readonly HealthEvidence[],
  limitations: readonly string[],
  items?: readonly Record<string, unknown>[],
): HealthComponent {
  // A required check without a verdict keeps the component from being ok.
  const statuses = checks
    .filter((c) => c.required || c.status !== 'unknown')
    .map((c) => c.status)
  const status = statuses.length === 0 ? 'unknown' : worst(statuses)
  const lead = checks.find(
    (c) => c.status === status && (c.required || status !== 'unknown'),
  )
  return {
    id,
    label,
    status,
    summary:
      status === 'ok'
        ? 'Todas las comprobaciones obligatorias tienen evidencia reciente.'
        : (lead?.detail ?? 'Sin datos suficientes.'),
    checks,
    evidence,
    ...(items ? { items } : {}),
    limitations,
  }
}

interface Collected {
  readonly now: number
  readonly processes: Map<string, ProcessState>
  readonly supervisorAge: number | null
  readonly supervisorEvidence: HealthEvidence
  readonly supervisorUpdatedAt: number | null
  readonly kronosRunning: boolean | null
}

function collectSupervisor(
  options: ObservabilityHealthOptions,
  now: number,
): Collected {
  const health = readJson(options.processHealthPath)
  const updated = num(health?.updated_at_ms)
  const processes = new Map<string, ProcessState>()
  const table = rowOf(health?.processes)
  for (const [name, entry] of Object.entries(table)) {
    const status = rowOf(entry).status
    processes.set(
      name,
      status === 'running' || status === 'restarting' || status === 'down'
        ? status
        : 'unknown',
    )
  }
  const age = updated === null ? null : now - updated
  const kronos = rowOf(rowOf(health?.resources).kronos)
  return {
    now,
    processes,
    // A health file nobody rewrites says nothing about the present.
    supervisorAge: age,
    supervisorUpdatedAt: updated,
    supervisorEvidence: {
      source: 'dev-health.json (processes)',
      origin: options.processHealthPath
        ? basename(options.processHealthPath)
        : null,
      last_updated_ms: updated,
      state: health ? 'read' : 'missing',
      ...(health ? {} : { detail: 'file_not_found_or_unreadable' }),
    },
    kronosRunning: typeof kronos.running === 'boolean' ? kronos.running : null,
  }
}

/** Supervisor state of one process; `unknown` when the file is missing or stale. */
function processState(c: Collected, name: string): ProcessState {
  if (c.supervisorAge === null || c.supervisorAge > SUPERVISOR_OK_MS)
    return 'unknown'
  return c.processes.get(name) ?? 'absent'
}

// --- Datos ---------------------------------------------------------------

function dataComponent(
  options: ObservabilityHealthOptions,
  c: Collected,
): HealthComponent {
  const { now } = c
  const okMs = options.staleAfterMs ?? 15 * SECOND
  const errorMs = okMs * TICKER_WARN_FACTOR
  const captureProcess = processState(c, 'capture')
  const market = withDb(options.marketDbPath, (db) => {
    const ticker = db.prepare(
      `SELECT MAX(received_at) AS at FROM paper_futures_market_events
        WHERE product_id=? AND feed='ticker' AND received_at>=?`,
    )
    const candle = db.prepare(
      `SELECT MAX(bucket_start) AS bucket, MAX(known_at) AS known
         FROM paper_futures_official_candles
        WHERE product_id=? AND interval_ms=? AND bucket_start>=?`,
    )
    const latest = db
      .prepare(
        'SELECT received_at, feed FROM paper_futures_market_events ORDER BY rowid DESC LIMIT 1',
      )
      .get() as Row | undefined
    const gaps = db
      .prepare(
        `SELECT feed, product_id, COUNT(*) AS n, MAX(detected_at) AS last
           FROM paper_futures_data_gaps WHERE detected_at>=?
          GROUP BY feed, product_id`,
      )
      .all(now - GAP_WINDOW_MS) as Row[]
    return {
      tickers: options.products.map((product) => ({
        product,
        at: num(
          (ticker.get(product, now - TICKER_WINDOW_MS) as Row | undefined)?.at,
        ),
        candle: candle.get(product, MINUTE, now - CANDLE_ERROR_MS * 2) as
          Row | undefined,
      })),
      latestAt: num(latest?.received_at),
      latestFeed: typeof latest?.feed === 'string' ? latest.feed : null,
      gaps,
    }
  })

  const items: Record<string, unknown>[] = []
  const checks: HealthCheck[] = []
  const evidence: HealthEvidence[] = [c.supervisorEvidence]
  if (market.state !== 'read') {
    const detail = `Base de mercado no disponible (${market.detail}).`
    checks.push(
      check({
        id: 'ticker_freshness',
        label: 'Frescura del ticker',
        status: 'unknown',
        value: null,
        rule: `ok ≤ ${okMs / SECOND} s, warning ≤ ${errorMs / SECOND} s, error más allá`,
        detail,
      }),
      check({
        id: 'candle_freshness',
        label: 'Frescura de la vela de 1 min',
        status: 'unknown',
        value: null,
        rule: `ok ≤ ${CANDLE_OK_MS / SECOND} s, warning ≤ ${CANDLE_ERROR_MS / SECOND} s`,
        detail,
      }),
      check({
        id: 'data_gaps',
        label: 'Huecos de datos conocidos',
        status: 'unknown',
        value: null,
        rule: `warning si hay un hueco en los últimos ${GAP_RECENT_MS / MINUTE} min`,
        detail,
      }),
    )
    evidence.push(
      evidenceOf(
        'paper_futures_market_events / official_candles / data_gaps',
        options.marketDbPath,
        market,
        null,
      ),
    )
  } else {
    const { tickers, latestAt, latestFeed, gaps } = market.value
    const tickerStatuses: HealthStatus[] = []
    const candleStatuses: HealthStatus[] = []
    let newestTicker: number | null = null
    let newestCandle: number | null = null
    for (const row of tickers) {
      const age = row.at === null ? null : now - row.at
      const tickerStatus = ageStatus(age, okMs, errorMs)
      // No ticker in the lookback window is an error, not an unknown: the
      // source is readable and says there is nothing recent.
      tickerStatuses.push(tickerStatus === 'unknown' ? 'error' : tickerStatus)
      if (row.at !== null && (newestTicker === null || row.at > newestTicker))
        newestTicker = row.at
      const bucket = num(row.candle?.bucket)
      const closeAge = bucket === null ? null : now - (bucket + MINUTE)
      const candleStatus = ageStatus(closeAge, CANDLE_OK_MS, CANDLE_ERROR_MS)
      candleStatuses.push(candleStatus === 'unknown' ? 'error' : candleStatus)
      if (
        bucket !== null &&
        (newestCandle === null || bucket + MINUTE > newestCandle)
      )
        newestCandle = bucket + MINUTE
      items.push({
        product_id: row.product,
        ticker_status: tickerStatus === 'unknown' ? 'error' : tickerStatus,
        ticker_age_ms: age,
        candle_status: candleStatus === 'unknown' ? 'error' : candleStatus,
        last_closed_candle_age_ms: closeAge,
        candle_known_at_ms: num(row.candle?.known),
      })
    }
    const tickerStatus = worst(tickerStatuses)
    const otherFeedFresh =
      latestAt !== null && latestFeed !== 'ticker' && now - latestAt <= okMs
    const tickerPair = pairStatus(
      captureProcess,
      newestTicker === null ? null : now - newestTicker,
      okMs,
      errorMs,
      true,
    )
    checks.push(
      check({
        id: 'ticker_freshness',
        label: 'Frescura del ticker',
        status: tickerStatus,
        value:
          newestTicker === null
            ? null
            : Math.max(...items.map((i) => Number(i.ticker_age_ms ?? 0))),
        rule: `peor producto: ok ≤ ${okMs / SECOND} s (límite de captura), warning ≤ ${errorMs / SECOND} s; el ticker llega por REST cada 1 s`,
        detail:
          tickerStatus === 'ok'
            ? 'Los 8 productos recibieron ticker dentro del límite.'
            : otherFeedFresh
              ? `Hay eventos recientes de otro feed (${latestFeed}) pero el ticker no se actualiza.`
              : `Ticker desactualizado en ${tickerStatuses.filter((s) => s !== 'ok').length} producto(s).`,
      }),
      check({
        id: 'candle_freshness',
        label: 'Frescura de la vela de 1 min',
        status: worst(candleStatuses),
        value: newestCandle === null ? null : now - newestCandle,
        rule: `peor producto: ok ≤ ${CANDLE_OK_MS / SECOND} s, warning ≤ ${CANDLE_ERROR_MS / SECOND} s desde el cierre; la vela oficial se pide 3 s después de cada minuto`,
        detail:
          worst(candleStatuses) === 'ok'
            ? 'La última vela de 1 min cerrada es reciente en todos los productos.'
            : 'Velas oficiales de 1 min retrasadas o ausentes en algún producto.',
      }),
    )
    const recent = gaps.filter((g) => (num(g.last) ?? 0) >= now - GAP_RECENT_MS)
    const gapCount = gaps.reduce((sum, g) => sum + (num(g.n) ?? 0), 0)
    const lastGap = gaps.reduce<number | null>(
      (acc, g) => Math.max(acc ?? 0, num(g.last) ?? 0) || acc,
      null,
    )
    checks.push(
      check({
        id: 'data_gaps',
        label: 'Huecos de datos conocidos',
        status: recent.length > 0 ? 'warning' : 'ok',
        value: gapCount,
        rule: `warning si se registró un hueco en los últimos ${GAP_RECENT_MS / MINUTE} min; se cuentan los de ${GAP_WINDOW_MS / GAP_RECENT_MS} h`,
        detail:
          recent.length > 0
            ? `${recent.length} hueco(s) registrados en la última hora.`
            : `${gapCount} hueco(s) en 24 h, ninguno en la última hora.`,
      }),
      check({
        id: 'capture_process',
        label: 'Proceso de captura vs. datos',
        required: false,
        status: tickerPair.status,
        value: captureProcess,
        rule: 'un proceso activo sin ticker reciente es error (activo no es producir)',
        detail:
          tickerPair.reason === 'producing'
            ? 'La captura produce ticker.'
            : `Estado del proceso: ${captureProcess}; motivo: ${tickerPair.reason}.`,
      }),
    )
    evidence.push(
      evidenceOf(
        'paper_futures_market_events (feed=ticker)',
        options.marketDbPath,
        market,
        newestTicker,
      ),
      evidenceOf(
        'paper_futures_official_candles (1 min)',
        options.marketDbPath,
        market,
        newestCandle,
      ),
      evidenceOf(
        'paper_futures_data_gaps',
        options.marketDbPath,
        market,
        lastGap,
      ),
    )
  }
  const resilience = tailJson(options.resilienceLogPath)
  evidence.push({
    source: 'resilience.jsonl (cola de 64 KB)',
    origin: options.resilienceLogPath
      ? basename(options.resilienceLogPath)
      : null,
    last_updated_ms: resilience?.at ?? null,
    state: resilience ? 'read' : 'missing',
    ...(resilience
      ? {
          detail: `${resilience.failed} fallo(s) y ${resilience.recovering} recuperación(es) en la cola`,
        }
      : { detail: 'file_not_found_or_empty' }),
  })
  return makeComponent(
    'data',
    'Datos',
    checks,
    evidence,
    [
      'La frescura del ticker se mide sobre un REST de 1 s; un producto ilíquido con mark inmóvil igual emite ticker.',
      'La captura de trades en vivo existe solo para PF_XBTUSD: no se evalúa para los demás.',
      'El log de resiliencia es informativo; no cambia el estado.',
    ],
    items,
  )
}

/** Newest `at` and counts from the tail of the JSON-lines resilience log. */
function tailJson(
  path: string | undefined,
): { at: number | null; failed: number; recovering: number } | null {
  if (!path) return null
  let fd: number | undefined
  try {
    const size = statSync(path).size
    if (size === 0) return null
    fd = openSync(path, 'r')
    const length = Math.min(size, LOG_TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, size - length)
    const lines = buffer
      .toString('utf8')
      .split('\n')
      .slice(size > length ? 1 : 0)
    let at: number | null = null
    let failed = 0
    let recovering = 0
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const event = JSON.parse(line) as Row
        at = Math.max(at ?? 0, num(event.at) ?? 0) || at
        if (event.result === 'failed') failed += 1
        if (event.result === 'recovering') recovering += 1
      } catch {
        // A half-written last line is expected while the capture appends.
      }
    }
    return { at, failed, recovering }
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

// --- Verdicts (Procesamiento y Decisiones comparten la lectura) ------------

interface VerdictRead {
  readonly latest: readonly {
    product: string
    bucket: number | null
    writtenAt: number | null
    action: string | null
    reason: string | null
    inWindow: number
  }[]
}

function readVerdicts(
  options: ObservabilityHealthOptions,
  now: number,
): Opened<VerdictRead> {
  return withDb(options.verdictsDbPath, (db) => {
    const latest = db.prepare(
      `SELECT bucket_start, written_at, action, reason_code FROM paper_futures_verdicts
        WHERE product_id=? AND bucket_start>=? ORDER BY bucket_start DESC LIMIT 1`,
    )
    const count = db.prepare(
      `SELECT COUNT(*) AS n FROM paper_futures_verdicts
        WHERE product_id=? AND bucket_start>=?`,
    )
    return {
      latest: options.products.map((product) => {
        const row = latest.get(product, now - 6 * VERDICT_ERROR_MS) as
          Row | undefined
        return {
          product,
          bucket: num(row?.bucket_start),
          writtenAt: num(row?.written_at),
          action: typeof row?.action === 'string' ? row.action : null,
          reason: typeof row?.reason_code === 'string' ? row.reason_code : null,
          inWindow:
            num(
              (count.get(product, now - VERDICT_WINDOW_MS) as Row | undefined)
                ?.n,
            ) ?? 0,
        }
      }),
    }
  })
}

function processingComponent(
  options: ObservabilityHealthOptions,
  c: Collected,
  verdicts: Opened<VerdictRead>,
): HealthComponent {
  const { now } = c
  const checks: HealthCheck[] = []
  const evidence: HealthEvidence[] = [c.supervisorEvidence]
  const supervisorOk =
    c.supervisorAge !== null && c.supervisorAge <= SUPERVISOR_OK_MS
  checks.push(
    check({
      id: 'supervisor_health_file',
      label: 'Archivo de salud del supervisor',
      status: supervisorOk ? 'ok' : 'unknown',
      value: c.supervisorAge,
      rule: `ok si se actualizó hace ≤ ${SUPERVISOR_OK_MS / SECOND} s (el supervisor lo reescribe cada 5 s)`,
      detail: supervisorOk
        ? 'El supervisor informa procesos ahora.'
        : c.supervisorAge === null
          ? 'No hay archivo de salud del supervisor: el estado de los procesos es desconocido.'
          : 'El archivo de salud no se actualiza: el estado de los procesos es desconocido.',
    }),
  )
  const items: Record<string, unknown>[] = []
  for (const name of [...new Set([...CORE_PROCESSES, ...c.processes.keys()])]) {
    const state = processState(c, name)
    if (state === 'absent' || state === 'unknown') {
      items.push({
        process: name,
        state,
        core: CORE_PROCESSES.includes(name as never),
      })
      continue
    }
    const core = (CORE_PROCESSES as readonly string[]).includes(name)
    const status: HealthStatus =
      state === 'running'
        ? 'ok'
        : state === 'restarting'
          ? 'warning'
          : core
            ? 'error'
            : 'warning'
    items.push({ process: name, state, core, status })
    if (state !== 'running')
      checks.push(
        check({
          id: `process_${name}`,
          label: `Proceso ${name}`,
          required: false,
          status,
          value: state,
          rule: 'running=ok, restarting=warning, down=error (warning si no es del pipeline)',
          detail: `El supervisor informa ${name}: ${state}.`,
        }),
      )
  }
  const launched = items.filter((i) => i.state === 'running').length
  if (supervisorOk && launched === 0)
    checks.push(
      check({
        id: 'processes_running',
        label: 'Procesos en ejecución',
        status: 'error',
        value: 0,
        rule: 'ok si al menos un proceso del pipeline corre',
        detail: 'El supervisor no informa ningún proceso en ejecución.',
      }),
    )
  const verdictProcess = processState(c, 'verdict')
  if (verdicts.state !== 'read') {
    checks.push(
      check({
        id: 'evaluations_continuity',
        label: 'Continuidad de evaluaciones (verdicts)',
        status: verdictProcess === 'running' ? 'error' : 'unknown',
        value: null,
        rule: `ok si el verdict más nuevo tiene ≤ ${VERDICT_OK_MS / MINUTE} min`,
        detail:
          verdictProcess === 'running'
            ? 'El proceso verdict corre pero su base no existe o no se puede leer.'
            : `Base de verdicts no disponible (${verdicts.detail}).`,
      }),
    )
    evidence.push(
      evidenceOf(
        'paper_futures_verdicts',
        options.verdictsDbPath,
        verdicts,
        null,
      ),
    )
  } else {
    const newest = verdicts.value.latest.reduce<number | null>(
      (acc, v) =>
        v.writtenAt !== null && (acc === null || v.writtenAt > acc)
          ? v.writtenAt
          : acc,
      null,
    )
    const pair = pairStatus(
      verdictProcess,
      newest === null ? null : now - newest,
      VERDICT_OK_MS,
      VERDICT_ERROR_MS,
      false,
    )
    checks.push(
      check({
        id: 'evaluations_continuity',
        label: 'Continuidad de evaluaciones (verdicts)',
        status: pair.status,
        value: newest === null ? null : now - newest,
        rule: `ok si el verdict más nuevo tiene ≤ ${VERDICT_OK_MS / MINUTE} min (un verdict por producto y minuto); un proceso activo sin verdicts recientes es error`,
        detail:
          pair.reason === 'producing'
            ? 'El servicio de verdicts está escribiendo evaluaciones.'
            : `Proceso verdict: ${verdictProcess}; motivo: ${pair.reason}.`,
      }),
    )
    evidence.push(
      evidenceOf(
        'paper_futures_verdicts (written_at)',
        options.verdictsDbPath,
        verdicts,
        newest,
      ),
    )
  }
  return makeComponent(
    'processing',
    'Procesamiento',
    checks,
    evidence,
    [
      'Solo se conocen los procesos que lanzó el supervisor de `pnpm dev`; con DEV_ONLY un proceso ausente es «sin datos», no caído.',
      'En Windows el supervisor no reescribe su archivo cada 5 s: el estado de procesos queda desconocido.',
      'Kronos corre fuera del supervisor y se evalúa en Estrategias por su resumen.',
    ],
    items,
  )
}

function decisionsComponent(
  options: ObservabilityHealthOptions,
  c: Collected,
  verdicts: Opened<VerdictRead>,
): HealthComponent {
  const { now } = c
  const checks: HealthCheck[] = []
  const evidence: HealthEvidence[] = []
  const items: Record<string, unknown>[] = []
  const verdictProcess = processState(c, 'verdict')
  if (verdicts.state !== 'read') {
    checks.push(
      check({
        id: 'verdict_cadence',
        label: 'Cadencia de decisiones C',
        status: verdictProcess === 'running' ? 'error' : 'unknown',
        value: null,
        rule: `ok ≤ ${VERDICT_OK_MS / MINUTE} min por producto, warning ≤ ${VERDICT_ERROR_MS / MINUTE} min`,
        detail: `Base de verdicts no disponible (${verdicts.detail}).`,
      }),
    )
    evidence.push(
      evidenceOf(
        'paper_futures_verdicts',
        options.verdictsDbPath,
        verdicts,
        null,
      ),
    )
  } else {
    const statuses: HealthStatus[] = []
    let newest: number | null = null
    for (const v of verdicts.value.latest) {
      const age = v.writtenAt === null ? null : now - v.writtenAt
      const pair = pairStatus(
        verdictProcess,
        age,
        VERDICT_OK_MS,
        VERDICT_ERROR_MS,
        false,
      )
      statuses.push(pair.status)
      if (v.writtenAt !== null && (newest === null || v.writtenAt > newest))
        newest = v.writtenAt
      items.push({
        product_id: v.product,
        status: pair.status,
        reason: pair.reason,
        action: v.action,
        reason_code: v.reason,
        bucket_start_ms: v.bucket,
        written_at_ms: v.writtenAt,
        age_ms: age,
        evaluations_last_10_min: v.inWindow,
        expected_last_10_min: VERDICT_WINDOW_MS / MINUTE,
      })
    }
    const status = worst(statuses)
    checks.push(
      check({
        id: 'verdict_cadence',
        label: 'Cadencia de decisiones C',
        status,
        value: newest === null ? null : now - newest,
        rule: `peor producto: ok ≤ ${VERDICT_OK_MS / MINUTE} min (cadencia 1 por minuto, margen 3×), warning ≤ ${VERDICT_ERROR_MS / MINUTE} min`,
        detail:
          status === 'ok'
            ? 'Todos los productos tienen una decisión C reciente.'
            : `Decisiones C desactualizadas o ausentes en ${statuses.filter((s) => s !== 'ok').length} producto(s).`,
      }),
    )
    evidence.push(
      evidenceOf(
        'paper_futures_verdicts (último por producto)',
        options.verdictsDbPath,
        verdicts,
        newest,
      ),
    )
  }
  const q = withDb(options.decisionsDbPath, (db) =>
    rowOf(
      db
        .prepare(
          `SELECT MAX(written_at) AS at, COUNT(*) AS n FROM paper_futures_llm_decisions WHERE written_at>=?`,
        )
        .get(now - 6 * VERDICT_ERROR_MS),
    ),
  )
  const qAt = q.state === 'read' ? num(q.value.at) : null
  checks.push(
    check({
      id: 'qwen_decisions',
      label: 'Decisiones de Qwen (Q)',
      required: false,
      status: 'unknown',
      value: qAt === null ? null : now - qAt,
      rule: 'sin umbral: Q salta los minutos en calma (calm-skip), no hay cadencia fija documentada',
      detail:
        q.state !== 'read'
          ? `Base de decisiones de Qwen no disponible (${q.detail}).`
          : qAt === null
            ? 'Qwen no registró decisiones en la última hora.'
            : 'Última decisión de Qwen informada; sin cadencia esperada no se juzga.',
    }),
  )
  evidence.push(
    evidenceOf(
      'paper_futures_llm_decisions (written_at)',
      options.decisionsDbPath,
      q,
      qAt,
    ),
  )
  return makeComponent(
    'decisions',
    'Decisiones',
    checks,
    evidence,
    [
      'Una decisión C WAIT cuenta como decisión: la cadencia mide que se evalúa, no que se opera.',
      'Q (Qwen) no tiene cadencia fija: se informa su última decisión sin juzgarla.',
      'Los descartes del forward y los fallos de Q no se persisten (B4 pospuesto).',
    ],
    items,
  )
}

// --- Estrategias y Ejecución paper -----------------------------------------

interface ForwardRow {
  readonly strategy: string
  readonly product: string
  readonly checkedMs: number | null
  readonly candleLagMs: number | null
  readonly missing1m: number
  readonly late1m: number
  readonly diverged: number
  readonly blockedStale: number
  readonly staleCycles: number
}

interface ForwardRead {
  readonly rows: readonly ForwardRow[]
  readonly open: number
}

/**
 * `forward_status` has one row per (strategy, product), rewritten every cycle,
 * and `forward_open` one per pair: both are bounded by strategies × products,
 * never by the trade history. `forward_trade` is deliberately not read here
 * (last trade per experiment is B2).
 */
function readForward(options: ObservabilityHealthOptions): Opened<ForwardRead> {
  return withDb(options.forwardDbPath, (db) => {
    const rows = (
      db
        .prepare('SELECT strategy_id, product_id, payload FROM forward_status')
        .all() as Row[]
    ).map((r): ForwardRow => {
      let p: Row = {}
      try {
        p = rowOf(JSON.parse(String(r.payload)))
      } catch {
        // A payload that does not parse counts as a status without data.
      }
      return {
        strategy: String(r.strategy_id),
        product: String(r.product_id),
        checkedMs: num(p.checked_ms),
        candleLagMs: num(p.candle_lag_ms),
        missing1m: num(p.missing_1m) ?? 0,
        late1m: num(p.late_1m) ?? 0,
        diverged: num(p.diverged_trades) ?? 0,
        blockedStale: num(p.blocked_stale_entries) ?? 0,
        staleCycles: num(p.stale_cycles) ?? 0,
      }
    })
    const open = db.prepare('SELECT payload FROM forward_open').all() as Row[]
    return {
      rows,
      open: open.filter((o) => o.payload !== null && o.payload !== 'null')
        .length,
    }
  })
}

export interface RegistryEntry {
  readonly id: string
  readonly version: number | null
  readonly state: string
  readonly at: number | null
}

/**
 * The state the forward runner sees per strategy (mirror of
 * `futures_strategy_registry.forward_candidates`): the active version if any,
 * otherwise the newest version with its own state.
 */
export function readRegistry(
  options: ObservabilityHealthOptions,
): Opened<RegistryEntry[]> {
  return withDb(options.strategiesDbPath, (db) => {
    const versions = db
      .prepare(
        `SELECT e.strategy_id AS id, e.version AS version, e.state AS state, e.known_at AS at
           FROM strategy_events e
           JOIN (SELECT strategy_id, version, MAX(seq) AS seq FROM strategy_events GROUP BY strategy_id, version) m
             ON m.seq = e.seq
          ORDER BY e.version`,
      )
      .all() as Row[]
    const chosen = new Map<string, RegistryEntry>()
    for (const v of versions) {
      const entry: RegistryEntry = {
        id: String(v.id),
        version: num(v.version),
        state: String(v.state),
        at: num(v.at),
      }
      const current = chosen.get(entry.id)
      if (entry.state === 'active' || !current || current.state !== 'active')
        chosen.set(entry.id, entry)
    }
    return [...chosen.values()]
  })
}

export interface ExpectedStrategy {
  readonly id: string
  readonly source: 'registro' | 'archivo de registro forward'
  /** When the registry switched it on (0/null: shipped or from the file). */
  readonly activeSinceMs: number | null
}

export type Expected =
  | {
      readonly state: 'known'
      readonly strategies: readonly ExpectedStrategy[]
      readonly products: readonly string[]
      readonly notes: readonly string[]
    }
  | { readonly state: 'unknown'; readonly reason: string }

/**
 * Which (strategy, product) pairs the forward runner must be updating now,
 * rebuilt from the same inputs as `futures_forward.effective_registration`:
 * the registered file, minus the strategies the registry says are not active,
 * plus every strategy the registry has active; every product of the forward's
 * list (the runner has no per-strategy product filter). When any input cannot
 * be read the set cannot be known, and that is reported, never assumed.
 */
export function expectedPairs(
  options: ObservabilityHealthOptions,
  registry: Opened<RegistryEntry[]>,
): Expected {
  if (registry.state !== 'read')
    return {
      state: 'unknown',
      reason: `registro de estrategias no disponible (${registry.detail})`,
    }
  const registration = readJson(options.forwardRegistrationPath)
  const registered = rowOf(registration?.strategies)
  if (!registration || !('strategies' in registration))
    return {
      state: 'unknown',
      reason: 'archivo de estrategias del forward no disponible',
    }
  const products = options.forwardProducts ?? options.products
  if (products.length === 0)
    return { state: 'unknown', reason: 'lista de productos del forward vacía' }
  const byId = new Map(registry.value.map((s) => [s.id, s]))
  const notes: string[] = []
  const strategies: ExpectedStrategy[] = []
  let specIds: Set<string> | null = null
  const specs = () => {
    if (specIds) return specIds
    specIds = new Set<string>()
    for (const file of listJson(options.strategySpecsDir)) {
      const id = readJson(file)?.id
      if (typeof id === 'string') specIds.add(id)
    }
    return specIds
  }
  for (const id of Object.keys(registered)) {
    const entry = byId.get(id)
    if (entry && entry.state !== 'active') continue
    if (!entry) {
      // Only a spec in the specs folder can be run for a file-only strategy.
      if (!options.strategySpecsDir)
        return {
          state: 'unknown',
          reason: `no se puede comprobar la especificación de ${id} (carpeta de specs sin configurar)`,
        }
      if (!specs().has(id)) {
        notes.push(
          `${id} figura en el archivo pero no tiene especificación: el forward la omite`,
        )
        continue
      }
    }
    strategies.push({
      id,
      source: 'archivo de registro forward',
      activeSinceMs: entry?.at ?? null,
    })
  }
  for (const entry of registry.value)
    if (entry.state === 'active' && !(entry.id in registered))
      strategies.push({
        id: entry.id,
        source: 'registro',
        activeSinceMs: entry.at,
      })
  return { state: 'known', strategies, products, notes }
}

function listJson(dir: string | undefined): string[] {
  if (!dir) return []
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => join(dir, name))
  } catch {
    return []
  }
}

interface PairResult {
  readonly strategy: string
  readonly product: string
  readonly status: HealthStatus
  readonly reason: string
  readonly row: ForwardRow | undefined
  readonly ageMs: number | null
}

/** Freshness of every expected pair on its own row of `forward_status`. */
function pairResults(
  expected: Extract<Expected, { state: 'known' }>,
  forward: ForwardRead,
  process: ProcessState,
  now: number,
): PairResult[] {
  const rows = new Map(
    forward.rows.map((r) => [`${r.strategy}\u0000${r.product}`, r]),
  )
  const out: PairResult[] = []
  for (const strategy of expected.strategies)
    for (const product of expected.products) {
      const row = rows.get(`${strategy.id}\u0000${product}`)
      const age = row?.checkedMs == null ? null : now - row.checkedMs
      let { status, reason } = pairStatus(
        process,
        age,
        FORWARD_OK_MS,
        FORWARD_ERROR_MS,
        false,
      )
      // A strategy switched on a moment ago has no row until the next cycle.
      if (
        row === undefined &&
        strategy.activeSinceMs !== null &&
        strategy.activeSinceMs > 0 &&
        now - strategy.activeSinceMs <= FORWARD_OK_MS
      ) {
        status = 'warning'
        reason = 'awaiting_first_cycle'
      } else if (row === undefined && status === 'unknown') {
        reason = 'no_row_and_no_process_info'
      }
      out.push({
        strategy: strategy.id,
        product,
        status,
        reason,
        row,
        ageMs: age,
      })
    }
  return out
}

function describePairs(pairs: readonly PairResult[], limit = 8): string {
  const late = pairs.filter((p) => p.status !== 'ok')
  const shown = late.slice(0, limit).map((p) => {
    const age =
      p.ageMs === null ? 'sin estado' : `${Math.round(p.ageMs / MINUTE)} min`
    return `${p.strategy}/${p.product} (${age})`
  })
  return `${shown.join(', ')}${late.length > limit ? ` y ${late.length - limit} más` : ''}`
}

function experimentRow(
  id: string,
  label: string,
  process: ProcessState,
  summaryAt: number | null,
  now: number,
  loopMs: number,
) {
  const age = summaryAt === null ? null : now - summaryAt
  const pair = pairStatus(process, age, 1.5 * loopMs, 2 * loopMs, false)
  return {
    id,
    label,
    status: pair.status,
    reason: pair.reason,
    process,
    summary_updated_at_ms: summaryAt,
    summary_age_ms: age,
    expected_loop_ms: loopMs,
  }
}

function strategiesComponent(
  options: ObservabilityHealthOptions,
  c: Collected,
  forward: Opened<ForwardRead>,
  registry: Opened<RegistryEntry[]>,
  expected: Expected,
): HealthComponent {
  const { now } = c
  const checks: HealthCheck[] = []
  const evidence: HealthEvidence[] = []
  const items: Record<string, unknown>[] = []
  const active =
    registry.state === 'read'
      ? registry.value.filter((s) => s.state === 'active')
      : []
  const lastEvent =
    registry.state === 'read'
      ? registry.value.reduce<number | null>(
          (a, s) => Math.max(a ?? 0, s.at ?? 0) || a,
          null,
        )
      : null
  evidence.push(
    evidenceOf(
      'strategy_events (estado por estrategia y versión)',
      options.strategiesDbPath,
      registry,
      lastEvent,
    ),
  )
  checks.push(
    check({
      id: 'registry',
      label: 'Registro de estrategias',
      status: registry.state === 'read' ? 'ok' : 'unknown',
      value: registry.state === 'read' ? active.length : null,
      rule: 'ok si el registro se puede leer; solo prueba que existe, no que las estrategias operen',
      detail:
        registry.state === 'read'
          ? `${active.length} estrategia(s) activa(s) de ${registry.value.length} registradas.`
          : `Registro no disponible (${registry.detail}).`,
    }),
  )
  const coverageRule =
    'por estrategia esperada: ok si todos sus productos tienen un ciclo forward vigente (≤ 45 min); warning si algunos no; error si ninguno. Una fila antigua no cuenta como actividad'
  if (expected.state === 'unknown') {
    checks.push(
      check({
        id: 'forward_coverage',
        label: 'Forward vigente por estrategia activa',
        status: 'unknown',
        value: null,
        rule: coverageRule,
        detail: `No se puede determinar qué estrategias debe actualizar el forward: ${expected.reason}.`,
      }),
    )
  } else if (forward.state !== 'read') {
    checks.push(
      check({
        id: 'forward_coverage',
        label: 'Forward vigente por estrategia activa',
        status: 'unknown',
        value: null,
        rule: coverageRule,
        detail: `Base del forward no disponible (${forward.detail}).`,
      }),
    )
    evidence.push(
      evidenceOf('forward_status', options.forwardDbPath, forward, null),
    )
  } else {
    const pairs = pairResults(
      expected,
      forward.value,
      processState(c, 'forward'),
      now,
    )
    const statuses: HealthStatus[] = []
    for (const strategy of expected.strategies) {
      const own = pairs.filter((p) => p.strategy === strategy.id)
      const fresh = own.filter((p) => p.status === 'ok').length
      const unknown = own.some((p) => p.status === 'unknown')
      const status: HealthStatus =
        fresh === own.length
          ? 'ok'
          : unknown && fresh === 0
            ? 'unknown'
            : fresh === 0
              ? 'error'
              : unknown
                ? 'unknown'
                : 'warning'
      statuses.push(status)
      items.push({
        strategy_id: strategy.id,
        source: strategy.source,
        active_since_ms: strategy.activeSinceMs,
        status,
        products_expected: own.length,
        products_current: fresh,
        products_delayed: own
          .filter((p) => p.status !== 'ok')
          .map((p) => ({
            product_id: p.product,
            status: p.status,
            reason: p.reason,
            age_ms: p.ageMs,
          })),
      })
    }
    const status =
      expected.strategies.length === 0 ? 'unknown' : worst(statuses)
    checks.push(
      check({
        id: 'forward_coverage',
        label: 'Forward vigente por estrategia activa',
        status,
        value: pairs.filter((p) => p.status === 'ok').length,
        rule: coverageRule,
        detail:
          expected.strategies.length === 0
            ? 'Ninguna estrategia debe estar actualizándose: no hay nada que comprobar.'
            : status === 'ok'
              ? `Las ${expected.strategies.length} estrategia(s) tienen ciclo vigente en los ${expected.products.length} productos.`
              : `Sin ciclo vigente: ${describePairs(pairs)}.`,
      }),
    )
    evidence.push(
      evidenceOf(
        'forward_status (checked_ms por estrategia y producto)',
        options.forwardDbPath,
        forward,
        forward.value.rows.reduce<number | null>(
          (a, r) => Math.max(a ?? 0, r.checkedMs ?? 0) || a,
          null,
        ),
      ),
    )
  }
  const qwenExitRow = experimentRow(
    'qwen_exit_c31',
    'C31 Qwen decide salidas',
    processState(c, 'qwenexit'),
    num(readJson(options.qwenExitSummaryPath)?.updated_ms) ??
      fileMtimeMs(options.qwenExitSummaryPath),
    now,
    FORWARD_LOOP_MS,
  )
  const off = options.qwenExitOff
  const experiments = [
    off
      ? {
          ...qwenExitRow,
          status: 'unknown' as const,
          reason: `apagada: ${off.reason} (desde ${off.since})`,
        }
      : qwenExitRow,
    experimentRow(
      'kronos',
      'Kronos forward',
      c.kronosRunning === null
        ? 'unknown'
        : c.kronosRunning
          ? 'running'
          : 'down',
      fileMtimeMs(options.kronosSummaryPath),
      now,
      KRONOS_LOOP_MS,
    ),
  ]
  for (const e of experiments) {
    items.push({ experiment: e.id, ...e })
    checks.push(
      check({
        id: `experiment_${e.id}`,
        label: e.label,
        required: false,
        status: e.status,
        value: e.summary_age_ms,
        rule: `resumen actualizado ≤ 1,5 ciclos (${(e.expected_loop_ms * 1.5) / MINUTE} min); proceso activo sin resumen reciente es error`,
        detail: `Proceso: ${e.process}; motivo: ${e.reason}.`,
      }),
    )
  }
  evidence.push(
    {
      source: 'qwen-exit-summary.json (updated_ms)',
      origin: options.qwenExitSummaryPath
        ? basename(options.qwenExitSummaryPath)
        : null,
      last_updated_ms: experiments[0]!.summary_updated_at_ms,
      state:
        experiments[0]!.summary_updated_at_ms === null ? 'missing' : 'read',
    },
    {
      source: 'kronos-summary.json (mtime)',
      origin: options.kronosSummaryPath
        ? basename(options.kronosSummaryPath)
        : null,
      last_updated_ms: experiments[1]!.summary_updated_at_ms,
      state:
        experiments[1]!.summary_updated_at_ms === null ? 'missing' : 'read',
    },
  )
  return makeComponent(
    'strategies',
    'Estrategias',
    checks,
    evidence,
    [
      'Las estrategias esperadas se reconstruyen con las mismas entradas que el forward (archivo de registro, estado del registro, specs y lista de productos); si alguna no se puede leer, el resultado es «Sin datos».',
      'La lista de productos del forward se toma del mismo entorno que el gateway (FUTURES_PRODUCTS o la lista fijada).',
      'La última operación por experimento no está en B1: es B2.',
      'Kronos no está en el supervisor: su proceso se conoce solo por el muestreo de recursos (POSIX).',
      ...(expected.state === 'known' ? expected.notes : []),
    ],
    items,
  )
}

function paperComponent(
  options: ObservabilityHealthOptions,
  c: Collected,
  forward: Opened<ForwardRead>,
  expected: Expected,
): HealthComponent {
  const { now } = c
  const forwardProcess = processState(c, 'forward')
  const checks: HealthCheck[] = []
  const evidence: HealthEvidence[] = []
  const items: Record<string, unknown>[] = []
  const cycleRule = `por par estrategia/producto esperado: ok ≤ ${FORWARD_OK_MS / MINUTE} min (1,5 ciclos de ${FORWARD_LOOP_MS / MINUTE} min), warning ≤ ${FORWARD_ERROR_MS / MINUTE} min; proceso activo sin ciclo reciente es error; el estado es el del peor par`
  if (forward.state !== 'read') {
    checks.push(
      check({
        id: 'forward_cycle',
        label: 'Ciclo del forward por estrategia y producto',
        status: forwardProcess === 'running' ? 'error' : 'unknown',
        value: null,
        rule: cycleRule,
        detail:
          forwardProcess === 'running'
            ? 'El proceso forward corre pero su base no existe o no se puede leer.'
            : `Base del forward no disponible (${forward.detail}).`,
      }),
    )
    evidence.push(
      evidenceOf(
        'forward_status / forward_open',
        options.forwardDbPath,
        forward,
        null,
      ),
    )
  } else if (expected.state === 'unknown') {
    checks.push(
      check({
        id: 'forward_cycle',
        label: 'Ciclo del forward por estrategia y producto',
        status: 'unknown',
        value: null,
        rule: cycleRule,
        detail: `No se puede determinar qué pares debe actualizar el forward: ${expected.reason}. Una fila existente no demuestra actividad actual.`,
      }),
    )
    evidence.push(
      evidenceOf(
        'forward_status (checked_ms)',
        options.forwardDbPath,
        forward,
        forward.value.rows.reduce<number | null>(
          (a, r) => Math.max(a ?? 0, r.checkedMs ?? 0) || a,
          null,
        ),
      ),
    )
  } else {
    const pairs = pairResults(expected, forward.value, forwardProcess, now)
    const status =
      pairs.length === 0 ? 'unknown' : worst(pairs.map((p) => p.status))
    const ages = pairs
      .map((p) => p.ageMs)
      .filter((a): a is number => a !== null)
    const lead = pairs.find((p) => p.status === status && status !== 'ok')
    checks.push(
      check({
        id: 'forward_cycle',
        label: 'Ciclo del forward por estrategia y producto',
        status,
        value: ages.length === 0 ? null : Math.max(...ages),
        rule: cycleRule,
        detail:
          pairs.length === 0
            ? 'Ningún par debe actualizarse: no hay nada que comprobar.'
            : status === 'ok'
              ? `Los ${pairs.length} pares esperados tienen un ciclo vigente.`
              : `Pares retrasados: ${describePairs(pairs)}${lead ? ` (motivo del peor: ${lead.reason})` : ''}.`,
      }),
    )
    const own = pairs.flatMap((p) => (p.row ? [p.row] : []))
    const sum = (pick: (r: ForwardRow) => number) =>
      own.reduce((a, r) => a + pick(r), 0)
    const diverged = sum((r) => r.diverged)
    const lagging = own.filter((r) => (r.candleLagMs ?? 0) > LAG_WARN_MS).length
    const anomalous = diverged > 0 || lagging > 0
    checks.push(
      check({
        id: 'forward_anomalies',
        label: 'Anomalías registradas del forward',
        status: own.length === 0 ? 'unknown' : anomalous ? 'warning' : 'ok',
        value: own.length === 0 ? null : diverged + lagging,
        rule: `warning si hay trades divergentes (necesitan --rebuild) o velas con retraso > ${LAG_WARN_MS / MINUTE} min, solo en pares esperados; los bloqueos y ciclos obsoletos se informan sin juzgar`,
        detail:
          own.length === 0
            ? 'Los pares esperados no tienen estado registrado.'
            : anomalous
              ? `${diverged} trade(s) divergente(s), ${lagging} par(es) con vela retrasada.`
              : 'Sin divergencias ni retrasos de vela registrados.',
      }),
    )
    for (const p of pairs)
      items.push({
        strategy_id: p.strategy,
        product_id: p.product,
        status: p.status,
        reason: p.reason,
        checked_ms: p.row?.checkedMs ?? null,
        age_ms: p.ageMs,
        candle_lag_ms: p.row?.candleLagMs ?? null,
        missing_1m: p.row?.missing1m ?? null,
        late_1m: p.row?.late1m ?? null,
        diverged_trades: p.row?.diverged ?? null,
        blocked_stale_entries: p.row?.blockedStale ?? null,
        stale_cycles: p.row?.staleCycles ?? null,
      })
    const expectedKeys = new Set(
      pairs.map((p) => `${p.strategy}\u0000${p.product}`),
    )
    items.push({
      summary: {
        expected_pairs: pairs.length,
        current_pairs: pairs.filter((p) => p.status === 'ok').length,
        rows_not_expected: forward.value.rows.filter(
          (r) => !expectedKeys.has(`${r.strategy}\u0000${r.product}`),
        ).length,
        open_positions: forward.value.open,
        diverged_trades: diverged,
        blocked_stale_entries: sum((r) => r.blockedStale),
        stale_cycles: sum((r) => r.staleCycles),
      },
    })
    evidence.push(
      evidenceOf(
        'forward_status (checked_ms por estrategia y producto)',
        options.forwardDbPath,
        forward,
        ages.length === 0 ? null : now - Math.min(...ages),
        'última actualización = la del par más viejo',
      ),
    )
  }
  return makeComponent(
    'paper',
    'Ejecución paper',
    checks,
    evidence,
    [
      'Solo describe el forward; el libro D está retirado y no se evalúa.',
      'Las filas de pares que ya no se esperan (estrategia apagada) se cuentan aparte y no prueban actividad.',
      'No hay PnL no realizado ni posiciones abiertas por estrategia: falta B5.',
      'Los descartes del simulador (coste/protección) no se persisten (B4 pospuesto).',
    ],
    items,
  )
}

function riskComponent(): HealthComponent {
  const detail =
    'No existe una fuente de riesgo en el stack activo: multi_risk.py corre fuera de pnpm dev y no hay registro de rechazos, exposición, margen ni pérdida diaria.'
  return makeComponent(
    'risk',
    'Riesgo',
    [
      check({
        id: 'risk_source',
        label: 'Fuente de riesgo',
        status: 'unknown',
        value: null,
        rule: 'sin fuente verificable el estado es «Sin datos», nunca ok',
        detail,
      }),
    ],
    [
      {
        source: 'motor de riesgo',
        origin: null,
        last_updated_ms: null,
        state: 'missing',
        detail: 'no_source_in_active_stack',
      },
    ],
    [detail, 'No se infiere salud del riesgo por la ausencia de rechazos.'],
  )
}

/** Combines six component results into the report (exported for tests). */
export function assemble(
  components: readonly HealthComponent[],
  now: number,
  cacheMs: number,
): ObservabilityHealthReport {
  const failing = components
    .filter((c) => c.status === 'error' || c.status === 'warning')
    .map((c) => c.id)
  const unverified = components
    .filter((c) => c.status === 'unknown')
    .map((c) => c.id)
  const status = worst(components.map((c) => c.status))
  const reason =
    status === 'ok'
      ? 'Los seis componentes tienen evidencia reciente.'
      : status === 'unknown'
        ? `Ningún componente falla, pero ${unverified.length} sin verificar: no es saludable.`
        : `${failing.length} componente(s) con problemas${unverified.length ? ` y ${unverified.length} sin verificar` : ''}.`
  return {
    schema: 'observability-health.v1',
    generated_at_ms: now,
    cache_ms: cacheMs,
    overall: { status, reason, failing, unverified },
    components,
  }
}

export function createObservabilityHealth(
  options: ObservabilityHealthOptions,
): ObservabilityHealth {
  const clock = options.clock ?? Date.now
  const cacheMs = options.cacheMs ?? 15_000
  let cached: { at: number; value: ObservabilityHealthReport } | undefined
  return {
    report() {
      const now = clock()
      if (cached && now - cached.at >= 0 && now - cached.at < cacheMs)
        return cached.value
      const collected = collectSupervisor(options, now)
      const verdicts = readVerdicts(options, now)
      const forward = readForward(options)
      const registry = readRegistry(options)
      const expected = expectedPairs(options, registry)
      const value = assemble(
        [
          dataComponent(options, collected),
          processingComponent(options, collected, verdicts),
          strategiesComponent(options, collected, forward, registry, expected),
          decisionsComponent(options, collected, verdicts),
          paperComponent(options, collected, forward, expected),
          riskComponent(),
        ],
        now,
        cacheMs,
      )
      cached = { at: now, value }
      return value
    },
  }
}
