export interface SeededWindow<T> {
  readonly startIndex: number
  readonly values: readonly T[]
}

export interface SeededTimeWindow<T> {
  readonly since: number
  readonly until: number
  readonly seed: number
  readonly values: readonly T[]
}

export interface SeededTimeWindowConstraints {
  readonly after?: number
  readonly before?: number
  readonly maxGapMs?: number
}

export interface SmokeSelectionReport {
  readonly manifestHash: string
  readonly sample?: {
    readonly stage: string
    readonly until: number
    readonly horizons: readonly string[]
    readonly candidateIds: readonly string[]
  }
  readonly request: { readonly horizons: readonly string[] }
  readonly reports: readonly {
    readonly horizon: string
    readonly contentHash: string
    readonly rows: readonly {
      readonly candidateId: string
      readonly brier: number | null
    }[]
    readonly microCandidateDiagnostics?: {
      readonly candidates: readonly {
        readonly candidateId: string
        readonly selectionBrier: number | null
      }[]
    } | null
  }[]
}

export function confirmationCohort(
  report: SmokeSelectionReport | null,
  currentManifestHash: string,
  knownCandidateIds: ReadonlySet<string>,
): {
  readonly candidateIds: readonly string[]
  readonly embargoedUntil: number
  readonly smokeReportHash: string
} {
  if (
    report?.sample?.stage !== 'smoke' ||
    report.manifestHash !== currentManifestHash ||
    JSON.stringify(report.sample.horizons) !== '["15m"]' ||
    JSON.stringify(report.request.horizons) !== '["15m"]'
  )
    throw new Error(
      'Confirmation requires the latest compatible smoke report and unchanged candidate manifest.',
    )
  const selection = report.reports.find((entry) => entry.horizon === '15m')
  if (selection === undefined)
    throw new Error('Smoke report has no 15m selection results.')
  const candidateIds = report.sample.candidateIds
  if (
    candidateIds.length !== knownCandidateIds.size ||
    new Set(candidateIds).size !== candidateIds.length ||
    candidateIds.some((id) => !knownCandidateIds.has(id)) ||
    [...knownCandidateIds].some((id) => !candidateIds.includes(id))
  )
    throw new Error(
      'Smoke report candidate set does not match the active candidate manifest.',
    )
  return {
    candidateIds,
    embargoedUntil: report.sample.until + 60 * 60_000,
    smokeReportHash: selection.contentHash,
  }
}

/** Uniformly chooses a UTC minute start, independent of tick density. */
export function selectSeededTimeWindow<T>(
  values: readonly T[],
  durationMs: number,
  seed: number,
  timestampOf: (value: T) => number,
  constraints: SeededTimeWindowConstraints = {},
): SeededTimeWindow<T> {
  const minute = 60_000
  const maxGapMs = constraints.maxGapMs ?? 120_000
  if (!Number.isSafeInteger(seed) || seed < 0)
    throw new Error('Sample seed must be a non-negative safe integer.')
  if (
    !Number.isSafeInteger(durationMs) ||
    durationMs <= 0 ||
    durationMs % minute !== 0
  )
    throw new Error(
      'Sample duration must be a positive whole number of minutes.',
    )
  const ordered = [...values].sort((a, b) => timestampOf(a) - timestampOf(b))
  if (ordered.length === 0) throw new Error('No time data is available.')
  const times = ordered.map(timestampOf)
  const starts: number[] = []
  const lower = constraints.after ?? times[0]!
  const upper = constraints.before ?? times.at(-1)!
  for (
    let start = Math.ceil(lower / minute) * minute;
    start + durationMs <= upper;
    start += minute
  ) {
    let previous = start
    let clean = true
    for (let at = start; at <= start + durationMs; at += minute) {
      const index = lowerBound(times, at)
      if (index >= times.length || times[index]! - previous > maxGapMs) {
        clean = false
        break
      }
      previous = times[index]!
    }
    if (clean) starts.push(start)
  }
  if (starts.length === 0)
    throw new Error(
      `Not enough clean continuous data for a ${durationMs}ms window.`,
    )
  const state = (seed + 0x6d2b79f5) >>> 0
  let random = Math.imul(state ^ (state >>> 15), state | 1)
  random ^= random + Math.imul(random ^ (random >>> 7), random | 61)
  const draw = ((random ^ (random >>> 14)) >>> 0) / 4_294_967_296
  const since = starts[Math.floor(draw * starts.length)]!
  const until = since + durationMs
  return {
    since,
    until,
    seed,
    values: ordered.filter(
      (value) => timestampOf(value) >= since && timestampOf(value) < until,
    ),
  }
}

function lowerBound(values: readonly number[], target: number): number {
  let low = 0
  let high = values.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (values[middle]! < target) low = middle + 1
    else high = middle
  }
  return low
}

/** Select a fixed-length window from a continuous ordered segment using a seeded PRNG. */
export function selectSeededWindow<T>(
  values: readonly T[],
  length: number,
  seed: number,
  timestampOf: (value: T) => number,
  maxGapMs = 120_000,
): SeededWindow<T> {
  if (!Number.isSafeInteger(seed) || seed < 0)
    throw new Error('Sample seed must be a non-negative safe integer.')
  if (!Number.isSafeInteger(length) || length <= 0)
    throw new Error('Sample window length must be a positive integer.')
  const segments: { start: number; end: number }[] = []
  let start = 0
  for (let index = 1; index <= values.length; index += 1) {
    if (
      index === values.length ||
      timestampOf(values[index]!) - timestampOf(values[index - 1]!) > maxGapMs
    ) {
      if (index - start >= length) segments.push({ start, end: index })
      start = index
    }
  }
  const windows = segments.reduce(
    (count, segment) => count + segment.end - segment.start - length + 1,
    0,
  )
  if (windows === 0)
    throw new Error(
      `Not enough clean continuous data for a ${length}-observation window.`,
    )
  let state = seed >>> 0
  state = (state + 0x6d2b79f5) >>> 0
  let random = Math.imul(state ^ (state >>> 15), state | 1)
  random ^= random + Math.imul(random ^ (random >>> 7), random | 61)
  const draw = ((random ^ (random >>> 14)) >>> 0) / 4_294_967_296
  let offset = Math.floor(draw * windows)
  for (const segment of segments) {
    const count = segment.end - segment.start - length + 1
    if (offset < count) {
      const startIndex = segment.start + offset
      return {
        startIndex,
        values: values.slice(startIndex, startIndex + length),
      }
    }
    offset -= count
  }
  throw new Error('Unable to select a continuous sample window.')
}
