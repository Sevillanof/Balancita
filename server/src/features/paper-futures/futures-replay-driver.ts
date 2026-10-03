import { canonicalHash } from './futures-canonical.ts'

export type ReplayManifest = Readonly<{
  schema_version: 'futures-replay-manifest.v1'
  source: string
  source_hash: string
  config_hash: string
  seed: string
  fidelity: string
  runtime_version?: string
  instrument_hash?: string
}>

export type CausalInput = Readonly<{
  sequence: number
  received_at_ms: number
  event_time_ms: number
  known_at_ms?: number
  cycle_key?: string
  payload: Record<string, unknown>
}>

export type RuntimeWork = Readonly<{
  work_id: string
  analysis_id: string
  cycle_key: string
  version: number
  cutoff_received_at_ms: number
  virtual_time_ms: number
  input: CausalInput
}>

export type RuntimeReceipt = Readonly<{
  status: 'committed' | 'superseded'
  applied_state_version: number
  economic_projection?: Record<string, unknown>
  audit?: Record<string, unknown>
}>

type DriverOptions = {
  runId: string
  manifest: ReplayManifest
  apply: (work: RuntimeWork) => Promise<RuntimeReceipt>
}

type AppliedWork = RuntimeWork & { receipt: RuntimeReceipt }

/** Shared causal controller. Stream adapters and batch replay both call processEvent. */
export class FuturesReplayDriver {
  readonly manifest: ReplayManifest
  private readonly runId: string
  private readonly apply: DriverOptions['apply']
  private readonly inputs: CausalInput[] = []
  private readonly work: AppliedWork[] = []
  private readonly byWorkIdentity = new Map<string, AppliedWork>()
  private readonly bySequence = new Map<number, string>()
  private stateVersion = 0
  private virtualTime = 0

  constructor(options: DriverOptions) {
    validateManifest(options.manifest)
    if (!options.runId) throw new Error('Replay run identity is required.')
    this.runId = options.runId
    this.manifest = structuredClone(options.manifest)
    this.apply = options.apply
  }

  async processEvent(input: CausalInput, cutoff = input.received_at_ms) {
    validateInput(input, cutoff)
    const existingHash = this.bySequence.get(input.sequence)
    const inputHash = canonicalHash(input)
    if (existingHash) {
      if (existingHash !== inputHash)
        throw new Error('Received sequence is already bound to other evidence.')
      const duplicate = this.work.find(
        (item) => item.input.sequence === input.sequence,
      )
      return duplicate?.receipt
    }
    if (input.sequence !== this.inputs.length + 1)
      throw new Error('Causal inputs must arrive in persisted receive order.')
    if (input.known_at_ms !== undefined && input.known_at_ms > cutoff) return
    if (input.received_at_ms > cutoff) return
    if (input.received_at_ms < this.virtualTime)
      throw new Error('Virtual clock cannot move backwards.')

    this.virtualTime = Math.max(this.virtualTime, input.received_at_ms)
    this.inputs.push(structuredClone(input))
    this.bySequence.set(input.sequence, inputHash)
    const cycleKey = input.cycle_key ?? `received:${input.sequence}`
    const identity = canonicalHash({ cycleKey, evidence: inputHash })
    const prior = this.byWorkIdentity.get(identity)
    if (prior) return prior.receipt

    const work: RuntimeWork = {
      work_id: canonicalHash({ run_id: this.runId, identity }),
      analysis_id: canonicalHash({
        run_id: this.runId,
        identity,
        type: 'analysis',
      }),
      cycle_key: cycleKey,
      version: this.stateVersion,
      cutoff_received_at_ms: cutoff,
      virtual_time_ms: this.virtualTime,
      input: structuredClone(input),
    }
    const receipt = await this.apply(work)
    if (
      receipt.status === 'committed' &&
      receipt.applied_state_version === this.stateVersion + 1
    )
      this.stateVersion += 1
    else if (receipt.status === 'superseded') {
      // Preserve the durable result for audit but do not advance local state.
    } else {
      throw new Error(
        `Runtime receipt does not match expected version: ${JSON.stringify(receipt)}.`,
      )
    }
    const applied = { ...work, receipt: structuredClone(receipt) }
    this.work.push(applied)
    this.byWorkIdentity.set(identity, applied)
    return receipt
  }

  async advanceClock(timeMs: number): Promise<void> {
    if (!Number.isSafeInteger(timeMs) || timeMs < this.virtualTime)
      throw new Error('Virtual clock cannot move backwards.')
    this.virtualTime = timeMs
  }

  static async replay(
    options: DriverOptions & {
      inputs: readonly CausalInput[]
    },
  ): Promise<ReturnType<FuturesReplayDriver['exportRun']>> {
    const driver = new FuturesReplayDriver(options)
    for (const input of options.inputs) await driver.processEvent(input)
    return driver.exportRun()
  }

  exportRun() {
    const inputs = structuredClone(this.inputs)
    const work = this.work.map((item) => ({
      work_id: item.work_id,
      analysis_id: item.analysis_id,
      cycle_key: item.cycle_key,
      version: item.version,
      cutoff_received_at_ms: item.cutoff_received_at_ms,
      virtual_time_ms: item.virtual_time_ms,
      input_sequence: item.input.sequence,
      receipt: structuredClone(item.receipt),
    }))
    const economicProjection = this.work.map(
      (item) => item.receipt.economic_projection ?? {},
    )
    const manifest = structuredClone(this.manifest)
    return {
      schema_version: 'futures-replay-export.v1' as const,
      run_id: this.runId,
      manifest,
      manifest_hash: canonicalHash(manifest),
      inputs,
      work,
      economic_projection: economicProjection,
      semantic_hash: canonicalHash({
        schema_version: 'futures-economic-semantics.v1',
        manifest_hash: canonicalHash(manifest),
        inputs,
        economic_projection: cloneWithoutGeneratedIdentity(economicProjection),
      }),
      state_version: this.stateVersion,
    }
  }
}

const ECONOMIC_FIELDS = [
  'analysis',
  'analysis_id',
  'cycle_key',
  'cutoff_received_at_ms',
  'decision',
  'feature_conditions',
  'features',
  'reason_codes',
  'risk',
  'strategy_choices',
  'orders',
  'fills',
  'events',
  'position',
  'ledger',
  'funding',
  'coverage',
  'eligible_at_ms',
  'event_time_ms',
  'provider_receipt',
  'candle_bucket_start_ms',
] as const

export function economicSemanticProjection(
  value: unknown,
): Record<string, unknown> {
  if (!isRecord(value))
    throw new TypeError('Economic result must be an object.')
  const projection: Record<string, unknown> = {}
  for (const key of ECONOMIC_FIELDS)
    if (key in value)
      projection[key] = cloneWithoutGeneratedIdentity(value[key])
  return projection
}

export function compareEconomicSemantics(
  left: unknown,
  right: unknown,
): {
  equal: boolean
  hash: string
  differences: string[]
} {
  const leftProjection = semanticValue(left)
  const rightProjection = semanticValue(right)
  const leftHash = canonicalHash(leftProjection)
  const rightHash = canonicalHash(rightProjection)
  return {
    equal: leftHash === rightHash,
    hash: leftHash,
    differences:
      leftHash === rightHash
        ? []
        : differingPaths(leftProjection, rightProjection),
  }
}

function semanticValue(value: unknown): unknown {
  if (isRecord(value) && 'economic_projection' in value)
    return cloneWithoutGeneratedIdentity(value.economic_projection)
  return cloneWithoutGeneratedIdentity(value)
}

function cloneWithoutGeneratedIdentity(value: unknown): unknown {
  const generatedKeys = new Set([
    'run_id',
    'analysis_id',
    'work_id',
    'job_id',
    'order_id',
    'fill_id',
    'request_id',
    'id',
  ])
  const excluded = new Set([
    'record_hash',
    'snapshot_hash',
    'input_hash',
    'result_hash',
    'started_at',
    'completed_at',
    'published_at',
    'execution_duration_ms',
  ])
  const identities = new Map<string, string>()
  let nextIdentity = 0
  const collect = (item: unknown): void => {
    if (Array.isArray(item)) {
      item.forEach(collect)
      return
    }
    if (!isRecord(item)) return
    for (const [key, child] of Object.entries(item)) {
      if (
        generatedKeys.has(key) &&
        typeof child === 'string' &&
        !identities.has(child)
      )
        identities.set(child, `generated:${nextIdentity++}`)
      collect(child)
    }
  }
  collect(value)
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize)
    if (!isRecord(item))
      return typeof item === 'string'
        ? replaceIdentities(item, identities)
        : item
    return Object.fromEntries(
      Object.entries(item)
        .filter(([key]) => !excluded.has(key))
        .map(([key, child]) => [key, normalize(child)]),
    )
  }
  return normalize(value)
}

function replaceIdentities(
  value: string,
  identities: Map<string, string>,
): string {
  const ordered = [...identities.entries()].sort(
    (left, right) => right[0].length - left[0].length,
  )
  return ordered.reduce(
    (result, [identity, stable]) => result.split(identity).join(stable),
    value,
  )
}

function differingPaths(left: unknown, right: unknown, prefix = ''): string[] {
  if (canonicalHash(left) === canonicalHash(right)) return []
  if (!isRecord(left) || !isRecord(right)) return [prefix || '$']
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  return [...keys].flatMap((key) =>
    differingPaths(left[key], right[key], prefix ? `${prefix}.${key}` : key),
  )
}

function validateManifest(manifest: ReplayManifest): void {
  if (
    !isRecord(manifest) ||
    manifest.schema_version !== 'futures-replay-manifest.v1' ||
    !manifest.source ||
    !/^[a-f0-9]{64}$/.test(manifest.source_hash) ||
    !/^[a-f0-9]{64}$/.test(manifest.config_hash) ||
    !manifest.seed ||
    !manifest.fidelity
  )
    throw new Error('Replay manifest is incomplete or invalid.')
}

function validateInput(input: CausalInput, cutoff: number): void {
  if (
    !Number.isSafeInteger(input.sequence) ||
    input.sequence < 1 ||
    !Number.isSafeInteger(input.received_at_ms) ||
    input.received_at_ms < 0 ||
    !Number.isSafeInteger(input.event_time_ms) ||
    input.event_time_ms < 0 ||
    !Number.isSafeInteger(cutoff) ||
    cutoff < 0 ||
    !isRecord(input.payload)
  )
    throw new Error('Replay input or cutoff is invalid.')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
