import { canonicalHash } from './futures-canonical.ts'
import type { FuturesMarketStore } from '../kraken-futures/futures-market-store.ts'
import { randomUUID } from 'node:crypto'
import type { FuturesStore } from './futures-store.ts'

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
  durableStore?: FuturesStore
  initialStateVersion?: number
}

type AppliedWork = RuntimeWork & { receipt: RuntimeReceipt }

/** Shared causal controller. Stream adapters and batch replay both call processEvent. */
export class FuturesReplayDriver {
  readonly manifest: ReplayManifest
  private readonly runId: string
  private readonly apply: DriverOptions['apply']
  private readonly durableStore?: FuturesStore
  private durableBinding?: Record<string, unknown>
  private readonly inputs: CausalInput[] = []
  private readonly work: AppliedWork[] = []
  private readonly byWorkIdentity = new Map<string, AppliedWork>()
  private readonly bySequence = new Map<number, string>()
  private lastSequence = 0
  private stateVersion = 0
  private virtualTime = 0

  constructor(options: DriverOptions) {
    validateManifest(options.manifest)
    if (!options.runId) throw new Error('Replay run identity is required.')
    this.runId = options.runId
    this.manifest = structuredClone(options.manifest)
    this.apply = options.apply
    this.durableStore = options.durableStore
    if (
      options.initialStateVersion !== undefined &&
      (!Number.isSafeInteger(options.initialStateVersion) ||
        options.initialStateVersion < 0)
    )
      throw new Error('Replay state version is invalid.')
    this.stateVersion = options.initialStateVersion ?? 0
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
    if (input.sequence <= this.lastSequence)
      throw new Error('Causal inputs must arrive in persisted receive order.')
    if (input.known_at_ms !== undefined && input.known_at_ms > cutoff) return
    if (input.received_at_ms > cutoff) return
    if (input.received_at_ms < this.virtualTime)
      throw new Error('Virtual clock cannot move backwards.')

    this.virtualTime = Math.max(this.virtualTime, input.received_at_ms)
    this.inputs.push(structuredClone(input))
    this.bySequence.set(input.sequence, inputHash)
    this.lastSequence = input.sequence
    const cycleKey =
      input.cycle_key ?? `received:${input.sequence}:state:${this.stateVersion}`
    const identity = canonicalHash({ cycleKey, evidence: inputHash })
    const prior = this.byWorkIdentity.get(identity)
    if (prior) return prior.receipt

    const work: RuntimeWork = {
      work_id: canonicalHash({ run_id: this.runId, identity }),
      analysis_id: randomUUID(),
      cycle_key: cycleKey,
      version: this.stateVersion,
      cutoff_received_at_ms: cutoff,
      virtual_time_ms: this.virtualTime,
      input: structuredClone(input),
    }
    const durable = this.durableStore?.persistReplayWork(
      this.runId,
      input.sequence,
      inputHash,
      work,
    ) as (RuntimeWork & { receipt: RuntimeReceipt | null }) | undefined
    if (durable?.receipt) {
      const applied = { ...durable, receipt: structuredClone(durable.receipt) }
      this.work.push(applied)
      this.byWorkIdentity.set(identity, applied)
      this.stateVersion = Math.max(
        this.stateVersion,
        applied.receipt.applied_state_version,
      )
      return applied.receipt
    }
    const effectiveWork: RuntimeWork = durable
      ? {
          work_id: durable.work_id,
          analysis_id: durable.analysis_id,
          cycle_key: durable.cycle_key,
          version: durable.version,
          cutoff_received_at_ms: durable.cutoff_received_at_ms,
          virtual_time_ms: durable.virtual_time_ms,
          input: durable.input,
        }
      : work
    const receipt = await this.apply(effectiveWork)
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
    const applied = { ...effectiveWork, receipt: structuredClone(receipt) }
    if (receipt.status === 'committed')
      this.durableStore?.commitReplayWork(
        this.runId,
        effectiveWork.work_id,
        receipt,
      )
    this.work.push(applied)
    this.byWorkIdentity.set(identity, applied)
    return receipt
  }

  async advanceClock(timeMs: number): Promise<void> {
    if (!Number.isSafeInteger(timeMs) || timeMs < this.virtualTime)
      throw new Error('Virtual clock cannot move backwards.')
    this.virtualTime = timeMs
  }

  /** Feed persisted market rows through the same incremental causal core. */
  async processMarketStore(
    store: FuturesMarketStore,
    receivedCutoff: number,
    instrument: Record<string, unknown>,
    controlForSource?: (
      source: Record<string, unknown>,
    ) => Record<string, unknown> | undefined,
    mode: 'mock' | 'paper_live' = 'mock',
  ): Promise<void> {
    validateTimestamp(receivedCutoff, 'received cutoff')
    this.bindMarketSource(instrument, store)
    const allEvents = store.eventsAsOf(Number.MAX_SAFE_INTEGER) as Record<
      string,
      unknown
    >[]
    const eligible = allEvents.filter(
      (event) => Number(event.receivedAt) <= receivedCutoff,
    )
    for (const [sourceIndex, source] of eligible.entries()) {
      const receivedAt = Number(source.receivedAt)
      const gaps = store.gapsAsOf(receivedAt) as Record<string, unknown>[]
      const candles = (
        store.candlesAsOf(receivedAt) as Record<string, unknown>[]
      ).filter(
        (candle) =>
          !gaps.some(
            (gap) =>
              Number(gap.detected_at) < Number(candle.known_at) &&
              Number(candle.close_at) <= Number(gap.detected_at),
          ),
      )
      const current = eligible
        .slice(0, sourceIndex + 1)
        .filter((event) => Number(event.receivedAt) <= receivedAt)
      const marketEvents: Record<string, unknown>[] = candles.map((candle) => ({
        type: 'candle',
        interval_ms: Number(candle.interval_ms),
        bucket_start_ms: Number(candle.bucket_start),
        event_time_ms: Number(candle.close_at ?? candle.known_at),
        received_at_ms: Number(candle.known_at),
        known_at_ms: Number(candle.known_at),
        reception_order: Number(candle.known_at),
        closed: true,
        coverage: candle.coverage,
        open: candle.open_price,
        high: candle.high_price,
        low: candle.low_price,
        close: candle.close_price,
        volume_btc: candle.volume_btc,
      }))
      for (const event of current) {
        const known = Number(event.receivedAt)
        const eventAt = Number(event.eventTime)
        const seq = Number(event.receivedSequence)
        if (event.type === 'book' && event.snapshot === true) {
          const gap = gaps.some((item) => {
            if (item.feed !== 'book' || Number(item.detected_at) > known)
              return false
            return (
              eventAt <= Number(item.detected_at) ||
              (Number(event.epoch) === Number(item.epoch) &&
                Number(event.seq) < Number(item.actual_seq))
            )
          })
          marketEvents.push({
            type: 'book_snapshot',
            source_receipt_sequence: seq,
            provider: 'kraken-futures',
            product_id: 'PF_XBTUSD',
            epoch: String(event.epoch),
            sequence: seq,
            snapshot_id: `${event.epoch}:${event.seq}`,
            revision: String(event.seq),
            event_time_ms: eventAt,
            received_at_ms: known,
            known_at_ms: known,
            contiguous:
              (event.contiguous === true ||
                (isRecord(event.marketQuality) &&
                  event.marketQuality.schema_version ===
                    'futures-market-quality-attestation.v1' &&
                  event.marketQuality.policy_version ===
                    'snapshot-contiguous-observed.v1' &&
                  event.marketQuality.source_guarantee === 'undocumented' &&
                  event.marketQuality.book_sequence_integrity ===
                    'observed_contiguous')) &&
              !gap,
            valid:
              event.valid !== false &&
              (!isRecord(event.marketQuality) ||
                event.marketQuality.book_valid === true) &&
              !gap,
            bids: Array.isArray(event.bids)
              ? (event.bids as Record<string, string>[]).map((level) => ({
                  price_usd: level.price,
                  quantity_btc: level.quantity,
                }))
              : [],
            asks: Array.isArray(event.asks)
              ? (event.asks as Record<string, string>[]).map((level) => ({
                  price_usd: level.price,
                  quantity_btc: level.quantity,
                }))
              : [],
          })
        } else if (event.type === 'ticker') {
          marketEvents.push({
            type: 'ticker',
            source_receipt_sequence: seq,
            provider: 'kraken-futures',
            product_id: 'PF_XBTUSD',
            epoch: String(event.epoch),
            sequence: seq,
            event_time_ms: eventAt,
            received_at_ms: known,
            known_at_ms: known,
            mark_usd: event.mark ?? event.last,
            market_status: event.suspended ? 'suspended' : 'open',
          })
          if (event.fundingObservation) {
            marketEvents.push({
              type: 'funding_observation',
              received_at_ms: known,
              known_at_ms: known,
              observation: event.fundingObservation,
              reception_order: seq,
            })
          }
        } else if (event.type === 'trade') {
          marketEvents.push({
            type: event.recovered === true ? 'recovered_trade_audit' : 'trade',
            source_receipt_sequence: seq,
            provider: 'kraken-futures',
            product_id: 'PF_XBTUSD',
            epoch: String(event.epoch),
            uid: event.uid,
            event_time_ms: eventAt,
            received_at_ms: known,
            known_at_ms: known,
            price_usd: event.priceUsd,
            quantity_btc: event.quantityBtc,
            aggressor_side: event.side,
          })
        }
      }
      marketEvents.forEach((event, index) => {
        event.reception_order = index + 1
      })
      if (
        !marketEvents.some((event) => event.type === 'book_snapshot') ||
        !marketEvents.some((event) => event.type === 'ticker')
      )
        continue
      const snapshot = {
        mode,
        instrument,
        decision_time_ms: receivedAt,
        cutoff_received_at_ms: receivedAt,
        events: marketEvents,
      }
      const control = controlForSource?.(source)
      await this.processEvent(
        {
          sequence: Number(source.receivedSequence),
          received_at_ms: receivedAt,
          event_time_ms: Number(source.eventTime),
          known_at_ms: receivedAt,
          payload: {
            market_event: source,
            market_source_watermark: Number(source.receivedSequence),
            market_gaps: structuredClone(gaps),
            market_snapshot: snapshot,
            ...(control ? { control } : {}),
          },
        },
        receivedAt,
      )
    }
  }

  private bindMarketSource(
    instrument: Record<string, unknown>,
    sourceStore?: FuturesMarketStore,
  ): void {
    if (!this.durableStore) return
    const runtimeBinding = this.durableStore.getRuntimeBinding(this.runId)
    if (
      !runtimeBinding ||
      canonicalHash(runtimeBinding.runtime_config) !==
        this.manifest.config_hash ||
      canonicalHash(runtimeBinding.instrument_spec) !==
        canonicalHash(instrument) ||
      (this.manifest.instrument_hash !== undefined &&
        canonicalHash(instrument) !== this.manifest.instrument_hash)
    )
      throw new Error(
        'Replay session does not match the frozen runtime binding.',
      )
    if (
      sourceStore &&
      this.manifest.source !== 'kraken-public-live-stream.v1'
    ) {
      const sourceHash = canonicalHash({
        events: sourceStore.eventsAsOf(Number.MAX_SAFE_INTEGER),
        candles: sourceStore.candlesAsOf(Number.MAX_SAFE_INTEGER),
        gaps: sourceStore.gapsAsOf(Number.MAX_SAFE_INTEGER),
      })
      if (sourceHash !== this.manifest.source_hash)
        throw new Error(
          'Replay dataset hash does not match the frozen manifest.',
        )
    }
    const binding = {
      schema_version: 'futures-replay-session.v1',
      run_id: this.runId,
      manifest: this.manifest,
      instrument_hash: canonicalHash(instrument),
    }
    this.durableStore.bindReplaySession(this.runId, binding)
    this.durableBinding = binding
  }

  static async resumeMarketStore(
    options: DriverOptions & {
      durableStore: FuturesStore
      marketStore: FuturesMarketStore
      receivedCutoff: number
      instrument: Record<string, unknown>
      controlForSource?: (
        source: Record<string, unknown>,
      ) => Record<string, unknown> | undefined
    },
  ): Promise<FuturesReplayDriver> {
    const driver = new FuturesReplayDriver(options)
    driver.bindMarketSource(options.instrument, options.marketStore)
    const restored = options.durableStore.loadReplaySession(
      options.runId,
      driver.durableBinding,
    )
    for (const item of restored.works) {
      const work = item as RuntimeWork & { receipt: RuntimeReceipt | null }
      const input = work.input
      const inputHash = canonicalHash(input)
      driver.inputs.push(structuredClone(input))
      driver.bySequence.set(input.sequence, inputHash)
      driver.lastSequence = Math.max(driver.lastSequence, input.sequence)
      driver.virtualTime = Math.max(driver.virtualTime, work.virtual_time_ms)
      if (work.receipt) {
        driver.work.push({ ...work, receipt: structuredClone(work.receipt) })
        const identity = canonicalHash({
          cycleKey:
            input.cycle_key ??
            `received:${input.sequence}:state:${work.version}`,
          evidence: inputHash,
        })
        driver.byWorkIdentity.set(identity, {
          ...work,
          receipt: structuredClone(work.receipt),
        })
        driver.stateVersion = Math.max(
          driver.stateVersion,
          work.receipt.applied_state_version,
        )
      } else {
        const persisted = options.durableStore.getAppliedReceipt(work.work_id)
        if (persisted) {
          const receipt: RuntimeReceipt = {
            status: persisted.status as RuntimeReceipt['status'],
            applied_state_version: Number(persisted.applied_state_version),
          }
          options.durableStore.commitReplayWork(
            options.runId,
            work.work_id,
            receipt,
          )
          driver.work.push({ ...work, receipt })
          const identity = canonicalHash({
            cycleKey:
              input.cycle_key ??
              `received:${input.sequence}:state:${work.version}`,
            evidence: inputHash,
          })
          driver.byWorkIdentity.set(identity, { ...work, receipt })
          driver.stateVersion = Math.max(
            driver.stateVersion,
            receipt.applied_state_version,
          )
        } else {
          const receipt = await driver.apply(work)
          if (receipt.status !== 'committed')
            throw new Error(
              'Prepared replay work did not commit during restoration.',
            )
          options.durableStore.commitReplayWork(
            options.runId,
            work.work_id,
            receipt,
          )
          const applied = { ...work, receipt: structuredClone(receipt) }
          driver.work.push(applied)
          const identity = canonicalHash({
            cycleKey:
              input.cycle_key ??
              `received:${input.sequence}:state:${work.version}`,
            evidence: inputHash,
          })
          driver.byWorkIdentity.set(identity, applied)
          driver.stateVersion = Math.max(
            driver.stateVersion,
            receipt.applied_state_version,
          )
        }
      }
    }
    await driver.processMarketStore(
      options.marketStore,
      options.receivedCutoff,
      options.instrument,
      options.controlForSource,
    )
    return driver
  }

  static async resumeSession(
    options: DriverOptions & {
      durableStore: FuturesStore
      instrument: Record<string, unknown>
    },
  ): Promise<FuturesReplayDriver> {
    const driver = new FuturesReplayDriver(options)
    const binding = {
      schema_version: 'futures-replay-session.v1',
      run_id: options.runId,
      manifest: driver.manifest,
      instrument_hash: canonicalHash(options.instrument),
    }
    driver.durableBinding = binding
    const restored = options.durableStore.loadReplaySession(
      options.runId,
      binding,
    )
    for (const item of restored.works) {
      const work = item as RuntimeWork & { receipt: RuntimeReceipt | null }
      const input = work.input
      const inputHash = canonicalHash(input)
      driver.inputs.push(structuredClone(input))
      driver.bySequence.set(input.sequence, inputHash)
      driver.lastSequence = Math.max(driver.lastSequence, input.sequence)
      driver.virtualTime = Math.max(driver.virtualTime, work.virtual_time_ms)
      const identity = canonicalHash({
        cycleKey:
          input.cycle_key ?? `received:${input.sequence}:state:${work.version}`,
        evidence: inputHash,
      })
      let receipt = work.receipt
      if (!receipt) {
        receipt = await driver.apply(work)
        if (
          receipt.status !== 'committed' ||
          receipt.applied_state_version !== driver.stateVersion + 1
        )
          throw new Error(
            'Prepared replay work did not commit during restoration.',
          )
        options.durableStore.commitReplayWork(
          options.runId,
          work.work_id,
          receipt,
        )
      }
      driver.work.push({ ...work, receipt: structuredClone(receipt) })
      driver.byWorkIdentity.set(identity, {
        ...work,
        receipt: structuredClone(receipt),
      })
      driver.stateVersion = Math.max(
        driver.stateVersion,
        receipt.applied_state_version,
      )
    }
    return driver
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

  static async replayMarketStore(
    options: DriverOptions & {
      store: FuturesMarketStore
      receivedCutoff: number
      instrument: Record<string, unknown>
      controlForSource?: (
        source: Record<string, unknown>,
      ) => Record<string, unknown> | undefined
    },
  ): Promise<ReturnType<FuturesReplayDriver['exportRun']>> {
    const driver = new FuturesReplayDriver(options)
    await driver.processMarketStore(
      options.store,
      options.receivedCutoff,
      options.instrument,
      options.controlForSource,
    )
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

function validateTimestamp(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new TypeError(`${name} must be a non-negative safe integer.`)
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
  if (
    isRecord(value) &&
    value.schema_version === 'futures-replay-export.v1' &&
    'economic_projection' in value
  )
    return {
      ...(Array.isArray(value.inputs)
        ? { inputs: cloneWithoutGeneratedIdentity(value.inputs) }
        : {}),
      economic_projection: cloneWithoutGeneratedIdentity(
        value.economic_projection,
      ),
    }
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
    'event_id',
    'execution_event_id',
    'id',
  ])
  const excluded = new Set([
    ...generatedKeys,
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
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return [`${prefix || '$'}.length`]
    return left.flatMap((value, index) =>
      differingPaths(value, right[index], `${prefix}[${index}]`),
    )
  }
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
