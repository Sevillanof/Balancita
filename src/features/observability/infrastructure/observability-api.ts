import { record, type JsonRecord } from '../../../shared/wire/decode.ts'

/**
 * Read-only reports of the live gateway (`docs/observabilidad-salud-api.md`,
 * `docs/observabilidad-actividad-api.md`). The decoders keep what the backend
 * said and nothing else: no value is computed, defaulted to «healthy» or
 * filled in. A shape that does not match is an error, never a guess.
 */
export const HEALTH_URL = '/api-live/observability/health'
export const ACTIVITY_URL = '/api-live/observability/activity'

export type HealthStatus = 'ok' | 'warning' | 'error' | 'unknown'
export type ActivityWindow = '3h' | '24h'
export const ACTIVITY_WINDOWS: readonly ActivityWindow[] = ['3h', '24h']

const STATUSES: readonly string[] = ['ok', 'warning', 'error', 'unknown']
const COMPONENT_IDS = [
  'data',
  'processing',
  'strategies',
  'decisions',
  'paper',
  'risk',
] as const

export type HealthCheck = {
  id: string
  label: string
  status: HealthStatus
  required: boolean
  value: number | string | null
  rule: string
  detail: string
}

export type HealthEvidence = {
  source: string
  origin: string | null
  lastUpdatedMs: number | null
  state: string
  detail: string | null
}

export type HealthComponent = {
  id: (typeof COMPONENT_IDS)[number]
  label: string
  status: HealthStatus
  summary: string
  checks: HealthCheck[]
  evidence: HealthEvidence[]
  limitations: string[]
}

export type HealthReport = {
  generatedAtMs: number
  cacheMs: number
  overall: {
    status: HealthStatus
    reason: string
    failing: string[]
    unverified: string[]
  }
  components: HealthComponent[]
}

export type SectionEvidence = {
  source: string
  origin: string | null
  state: string
  detail: string | null
  rule: string
}

/** A section is either read (with its figures) or unavailable (with the reason). */
export type Section<T> =
  | ({ state: 'ok'; evidence: SectionEvidence } & T)
  | { state: 'unavailable'; evidence: SectionEvidence; detail: string }

export type ProductEvaluations = {
  product: string
  count: number
  expected: number
  missing: number
  firstBucketMs: number | null
  lastBucketMs: number | null
  lastKnownAtMs: number | null
  long: number
  short: number
  lastSignal: { bucketMs: number; action: string; reasonCode: string } | null
}

export type ReasonCount = {
  reasonCode: string
  action: string
  count: number
}

export type ExperimentActivity = {
  experimentId: string
  expectedActive: boolean | null
  tradesInWindow: number
  /** `forward_open` records: NOT verified current positions. */
  openRecords: number
  lastCycleMs: number | null
  lastTrade: {
    product: string
    side: string | null
    entryBucketMs: number
    exitBucketMs: number | null
    exitReason: string | null
  } | null
}

export type ActivityReport = {
  generatedAtMs: number
  window: ActivityWindow
  fromMs: number
  toMs: number
  product: string | null
  evaluations: Section<{ total: number; byProduct: ProductEvaluations[] }>
  signals: Section<{ total: number; long: number; short: number }>
  discards: Section<{
    total: number
    byReason: ReasonCount[]
    distinctReasons: number
    truncated: boolean
    omittedCount: number
    notRecorded: string[]
  }>
  operations: Section<{
    pairSource: string
    experiments: ExperimentActivity[]
    notes: string[]
  }>
}

export class UnexpectedReport extends Error {}

export function fail(what: string): never {
  throw new UnexpectedReport(`respuesta inesperada: ${what}`)
}

export const text = (value: unknown, what: string): string =>
  typeof value === 'string' ? value : fail(what)
export const integer = (value: unknown, what: string): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fail(what)
export const maybeInteger = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null
export const maybeText = (value: unknown): string | null =>
  typeof value === 'string' ? value : null
export const list = (value: unknown, what: string): unknown[] =>
  Array.isArray(value) ? value : fail(what)
export const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v) => typeof v === 'string') : []

function status(value: unknown, what: string): HealthStatus {
  return typeof value === 'string' && STATUSES.includes(value)
    ? (value as HealthStatus)
    : fail(what)
}

function decodeCheck(raw: unknown): HealthCheck {
  const c = record(raw)
  const value = c.value
  return {
    id: text(c.id, 'check.id'),
    label: text(c.label, 'check.label'),
    status: status(c.status, 'check.status'),
    required: c.required === true,
    value:
      typeof value === 'number' || typeof value === 'string' ? value : null,
    rule: text(c.rule, 'check.rule'),
    detail: maybeText(c.detail) ?? '',
  }
}

function decodeEvidence(raw: unknown): HealthEvidence {
  const e = record(raw)
  return {
    source: text(e.source, 'evidence.source'),
    origin: maybeText(e.origin),
    lastUpdatedMs: maybeInteger(e.last_updated_ms),
    state: text(e.state, 'evidence.state'),
    detail: maybeText(e.detail),
  }
}

export function decodeHealth(raw: unknown): HealthReport {
  const r = record(raw)
  if (r.schema !== 'observability-health.v1') fail('schema')
  const overall = record(r.overall)
  const components = list(r.components, 'components').map((item) => {
    const c = record(item)
    const id = (COMPONENT_IDS as readonly string[]).includes(String(c.id))
      ? (c.id as HealthComponent['id'])
      : fail('component.id')
    return {
      id,
      label: text(c.label, 'component.label'),
      status: status(c.status, 'component.status'),
      summary: text(c.summary, 'component.summary'),
      checks: list(c.checks, 'component.checks').map(decodeCheck),
      evidence: list(c.evidence, 'component.evidence').map(decodeEvidence),
      limitations: strings(c.limitations),
    }
  })
  return {
    generatedAtMs: integer(r.generated_at_ms, 'generated_at_ms'),
    cacheMs: integer(r.cache_ms, 'cache_ms'),
    overall: {
      status: status(overall.status, 'overall.status'),
      reason: text(overall.reason, 'overall.reason'),
      failing: strings(overall.failing),
      unverified: strings(overall.unverified),
    },
    components,
  }
}

export function decodeEvidenceOfSection(raw: unknown): SectionEvidence {
  const e = record(raw)
  return {
    source: text(e.source, 'section.evidence.source'),
    origin: maybeText(e.origin),
    state: text(e.state, 'section.evidence.state'),
    detail: maybeText(e.detail),
    rule: text(e.rule, 'section.evidence.rule'),
  }
}

export function section<T>(
  raw: unknown,
  what: string,
  read: (body: JsonRecord) => T,
): Section<T> {
  const s = record(raw)
  const evidence = decodeEvidenceOfSection(s.evidence)
  if (s.state === 'unavailable')
    return { state: 'unavailable', evidence, detail: text(s.detail, what) }
  if (s.state !== 'ok') fail(`${what}.state`)
  return { state: 'ok', evidence, ...read(s) }
}

function decodeProduct(raw: unknown): ProductEvaluations {
  const p = record(raw)
  const signal = p.last_signal === null ? null : record(p.last_signal)
  return {
    product: text(p.product, 'product'),
    count: integer(p.count, 'count'),
    expected: integer(p.expected, 'expected'),
    missing: integer(p.missing, 'missing'),
    firstBucketMs: maybeInteger(p.first_bucket_ms),
    lastBucketMs: maybeInteger(p.last_bucket_ms),
    lastKnownAtMs: maybeInteger(p.last_known_at_ms),
    long: integer(p.long, 'long'),
    short: integer(p.short, 'short'),
    lastSignal: signal && {
      bucketMs: integer(signal.bucket_ms, 'last_signal.bucket_ms'),
      action: text(signal.action, 'last_signal.action'),
      reasonCode: text(signal.reason_code, 'last_signal.reason_code'),
    },
  }
}

function decodeExperiment(raw: unknown): ExperimentActivity {
  const e = record(raw)
  const t = e.last_trade === null ? null : record(e.last_trade)
  return {
    experimentId: text(e.experiment_id, 'experiment_id'),
    expectedActive:
      typeof e.expected_active === 'boolean' ? e.expected_active : null,
    tradesInWindow: integer(e.trades_in_window, 'trades_in_window'),
    openRecords: integer(e.open_records, 'open_records'),
    lastCycleMs: maybeInteger(e.last_cycle_ms),
    lastTrade: t && {
      product: text(t.product, 'last_trade.product'),
      side: maybeText(t.side),
      entryBucketMs: integer(t.entry_bucket_ms, 'last_trade.entry_bucket_ms'),
      exitBucketMs: maybeInteger(t.exit_bucket_ms),
      exitReason: maybeText(t.exit_reason),
    },
  }
}

export function decodeActivity(raw: unknown): ActivityReport {
  const r = record(raw)
  if (r.window !== '3h' && r.window !== '24h') fail('window')
  return {
    generatedAtMs: integer(r.generated_at_ms, 'generated_at_ms'),
    window: r.window,
    fromMs: integer(r.from_ms, 'from_ms'),
    toMs: integer(r.to_ms, 'to_ms'),
    product: maybeText(r.product),
    evaluations: section(r.evaluations, 'evaluations', (s) => ({
      total: integer(s.total, 'evaluations.total'),
      byProduct: list(s.by_product, 'by_product').map(decodeProduct),
    })),
    signals: section(r.signals, 'signals', (s) => ({
      total: integer(s.total, 'signals.total'),
      long: integer(s.long, 'signals.long'),
      short: integer(s.short, 'signals.short'),
    })),
    discards: section(r.discards, 'discards', (s) => ({
      total: integer(s.total, 'discards.total'),
      byReason: list(s.by_reason, 'by_reason').map((item) => {
        const x = record(item)
        return {
          reasonCode: text(x.reason_code, 'reason_code'),
          action: text(x.action, 'action'),
          count: integer(x.count, 'count'),
        }
      }),
      distinctReasons: integer(s.distinct_reasons, 'distinct_reasons'),
      truncated: s.truncated === true,
      omittedCount: integer(s.omitted_count, 'omitted_count'),
      notRecorded: strings(s.not_recorded),
    })),
    operations: section(r.operations, 'operations', (s) => ({
      pairSource: text(s.pair_source, 'pair_source'),
      experiments: list(s.experiments, 'experiments').map(decodeExperiment),
      notes: strings(s.notes),
    })),
  }
}

export async function getJson(
  url: string,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

export async function fetchHealth(signal: AbortSignal): Promise<HealthReport> {
  return decodeHealth(await getJson(HEALTH_URL, signal))
}

export async function fetchActivity(
  window: ActivityWindow,
  product: string | null,
  signal: AbortSignal,
): Promise<ActivityReport> {
  const query = new URLSearchParams({ window })
  if (product) query.set('product', product)
  return decodeActivity(await getJson(`${ACTIVITY_URL}?${query}`, signal))
}
