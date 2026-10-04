import { canonicalHash } from './futures-canonical.ts'
import type { FuturesMarketStore } from '../kraken-futures/futures-market-store.ts'
import { randomUUID } from 'node:crypto'
import type { FuturesStore } from './futures-store.ts'
import { IncrementalMarketProjection } from './futures-market-projection.ts'

export type ReplayManifest = Readonly<{
  schema_version: 'futures-replay-manifest.v1'
  source: string
  source_hash: string
  config_hash: string
  seed: string
  fidelity: string
  runtime_version?: string
  instrument_hash?: string
  source_file_hash?: string
  source_metadata_hash?: string
  source_quality_hash?: string
  replay_cutoff_ms?: number
  admission_policy?: Readonly<{
    schema_version: 'futures-entry-admission.v1'
    evaluation_interval_ms: 5000
    hash: string
  }>
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
  observeTiming?: ReplayTimingObserver
  admissionForSource?: (
    runId: string,
    sourceClock: number,
  ) => Record<string, unknown>
}

export type ReplayTimingEvent = Readonly<{
  phase:
    | 'input-canonical-hash'
    | 'replay-work-create'
    | 'runner-invocation'
    | 'receipt-materialize-hash'
    | 'market-source-read-cache'
    | 'market-source-snapshot-preparation'
  outcome: 'start' | 'end' | 'error'
  monotonic_ms: number
  duration_ms: number
  run_id: string
  source_received_seq: number
  request_id?: string
  request_work_id?: string
  work_id: string | null
  assignment_state: 'unassigned_before_work_created' | 'assigned'
  error?: string
}>
export type ReplayTimingObserver = (event: ReplayTimingEvent) => void

type AppliedWork = RuntimeWork & { receipt: RuntimeReceipt }

/** Shared causal controller. Stream adapters and batch replay both call processEvent. */
export class FuturesReplayDriver {
  readonly manifest: ReplayManifest
  private readonly runId: string
  private readonly apply: DriverOptions['apply']
  private readonly durableStore?: FuturesStore
  private readonly observeTiming?: DriverOptions['observeTiming']
  private readonly admissionForSource?: DriverOptions['admissionForSource']
  private durableBinding?: Record<string, unknown>
  private readonly inputs: CausalInput[] = []
  private readonly work: AppliedWork[] = []
  private readonly byWorkIdentity = new Map<string, AppliedWork>()
  private readonly bySequence = new Map<number, string>()
  private lastSequence = 0
  private stateVersion = 0
  private virtualTime = 0
  private marketSourceEvents: Record<string, unknown>[] | undefined
  private marketSourcePending: Record<string, unknown>[] = []
  private marketSourceReadCursor = 0
  private marketSourceCursor = 0
  private marketProjection?: IncrementalMarketProjection
  private marketProjectionDisabled = false
  private evaluationProgress?: {
    policyIdentity: string
    sourceIdentity: string
    cursorRowid: number
    nextDueAt: number | null
    nextDueReasons: string[]
  }

  constructor(options: DriverOptions) {
    validateManifest(options.manifest)
    if (!options.runId) throw new Error('Replay run identity is required.')
    this.runId = options.runId
    this.manifest = structuredClone(options.manifest)
    this.apply = options.apply
    this.durableStore = options.durableStore
    this.observeTiming = options.observeTiming
    this.admissionForSource = options.admissionForSource
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
    let workId: string | null = null
    const requestId =
      isRecord(input.payload.request) &&
      typeof input.payload.request.request_id === 'string'
        ? input.payload.request.request_id
        : undefined
    const requestWorkId =
      isRecord(input.payload.request) &&
      typeof input.payload.request.work_id === 'string'
        ? input.payload.request.work_id
        : undefined
    const measure = <T>(
      phase: ReplayTimingEvent['phase'],
      action: () => T,
    ): T => {
      const started = performance.now()
      try {
        const value = action()
        this.emitTiming(
          phase,
          'end',
          started,
          input.sequence,
          workId,
          undefined,
          requestId,
          requestWorkId,
        )
        return value
      } catch (error) {
        this.emitTiming(
          phase,
          'error',
          started,
          input.sequence,
          workId,
          error,
          requestId,
          requestWorkId,
        )
        throw error
      }
    }
    const inputHash = measure('input-canonical-hash', () =>
      canonicalHash(input),
    )
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
    workId = work.work_id
    const durable = measure(
      'replay-work-create',
      () =>
        this.durableStore?.persistReplayWork(
          this.runId,
          input.sequence,
          inputHash,
          work,
        ) as (RuntimeWork & { receipt: RuntimeReceipt | null }) | undefined,
    )
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
    const runnerStarted = performance.now()
    let receipt: RuntimeReceipt
    try {
      receipt = await this.apply(effectiveWork)
      this.emitTiming(
        'runner-invocation',
        'end',
        runnerStarted,
        input.sequence,
        workId,
        undefined,
        requestId,
        requestWorkId,
      )
    } catch (error) {
      this.emitTiming(
        'runner-invocation',
        'error',
        runnerStarted,
        input.sequence,
        workId,
        error,
        requestId,
        requestWorkId,
      )
      throw error
    }
    const receiptStarted = performance.now()
    try {
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
      this.emitTiming(
        'receipt-materialize-hash',
        'end',
        receiptStarted,
        input.sequence,
        workId,
        undefined,
        requestId,
        requestWorkId,
      )
      return receipt
    } catch (error) {
      this.emitTiming(
        'receipt-materialize-hash',
        'error',
        receiptStarted,
        input.sequence,
        workId,
        error,
        requestId,
        requestWorkId,
      )
      throw error
    }
  }

  private emitTiming(
    phase: ReplayTimingEvent['phase'],
    outcome: 'start' | 'end' | 'error',
    started: number,
    sourceReceivedSeq: number,
    workId: string | null,
    error?: unknown,
    requestId?: string,
    requestWorkId?: string,
  ): void {
    try {
      this.observeTiming?.({
        phase,
        outcome,
        monotonic_ms: performance.now(),
        duration_ms: Math.max(0, performance.now() - started),
        run_id: this.runId,
        source_received_seq: sourceReceivedSeq,
        ...(requestId === undefined ? {} : { request_id: requestId }),
        ...(requestWorkId === undefined
          ? {}
          : { request_work_id: requestWorkId }),
        work_id: workId,
        assignment_state:
          workId === null ? 'unassigned_before_work_created' : 'assigned',
        ...(error === undefined
          ? {}
          : { error: error instanceof Error ? error.message : String(error) }),
      })
    } catch {
      // Diagnostics are best-effort and must never affect replay semantics.
    }
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
    mode: 'mock' | 'paper_live' | 'replay' = 'mock',
    stopRequested?: () => boolean,
  ): Promise<{
    sourceWatermark: number
    lastDurableWatermark: number
    stopped: boolean
    deferredSourceRows: number
    durablePendingSourceRows: number
    durablePendingFirstSequence: number | null
    durablePendingLastSequence: number | null
  }> {
    validateTimestamp(receivedCutoff, 'received cutoff')
    this.bindMarketSource(instrument, store)
    const sourceReadStarted = performance.now()
    if (this.marketSourceEvents === undefined) {
      this.marketSourceEvents = store.eventsAsOf(
        Number.MAX_SAFE_INTEGER,
      ) as Record<string, unknown>[]
      this.marketSourceReadCursor = Number(
        this.marketSourceEvents.at(-1)?.receivedSequence ?? 0,
      )
      this.marketSourcePending = this.marketSourceEvents.filter(
        (event) => Number(event.receivedSequence) > this.marketSourceCursor,
      )
    } else {
      const appended = store.eventsAfter(this.marketSourceReadCursor) as Record<
        string,
        unknown
      >[]
      this.marketSourceEvents.push(...appended)
      this.marketSourcePending.push(...appended)
      this.marketSourceReadCursor = Number(
        appended.at(-1)?.receivedSequence ?? this.marketSourceReadCursor,
      )
    }
    this.emitTiming(
      'market-source-read-cache',
      'end',
      sourceReadStarted,
      this.marketSourceReadCursor,
      null,
    )
    const allEvents = this.marketSourceEvents
    this.ensureMarketProjection(allEvents)
    const eligible = this.marketSourcePending.filter(
      (event) =>
        Number(event.receivedSequence) > this.marketSourceCursor &&
        Number(event.receivedAt) <= receivedCutoff,
    )
    let stopped = false
    let deferredSourceRows = 0
    let pendingSkipped: {
      rowid: number
      sourceClock: number
      materializeInput: () => CausalInput | undefined
    }[] = []
    let inspectedSinceProgress = 0
    let pendingSkippedInspectedCount = 0
    const flushSkipped = async (): Promise<void> => {
      if (pendingSkipped.length === 0) return
      const rows = pendingSkipped
      pendingSkipped = []
      const last = rows.at(-1)!
      const admission = this.admissionForSource?.(this.runId, last.sourceClock)
      const progress = this.evaluationProgress!
      try {
        if (!this.isSafeIdleAdmission(admission, last.sourceClock))
          throw new Error('Admission changed before durable skip commit.')
        const due = admission!.next_due_at as Record<string, unknown>
        const rowids = rows.map((row) => row.rowid)
        if (
          rowids.some(
            (rowid, index) => index > 0 && rowid !== rowids[index - 1]! + 1,
          )
        )
          throw new Error('Skipped source range contains a ROWID hole.')
        this.durableStore!.commitEvaluationSkippedRange({
          runId: this.runId,
          expectedPolicyIdentity: progress.policyIdentity,
          expectedSourceIdentity: progress.sourceIdentity,
          expectedStateVersion: Number(admission!.confirmed_state_version),
          expectedHeadHash: String(admission!.head_hash),
          fromRowid: progress.cursorRowid + 1,
          toRowid: rowids.at(-1)!,
          inspectedRowCount: pendingSkippedInspectedCount,
          reason: 'confirmed-idle-before-next-due',
          nextDueAt: Number(due.time_ms),
          nextDueReasons: due.reasons as string[],
        })
        this.evaluationProgress = { ...progress, cursorRowid: rowids.at(-1)! }
        this.marketSourceCursor = rowids.at(-1)!
        inspectedSinceProgress = 0
        pendingSkippedInspectedCount = 0
      } catch {
        // On a guard race, process the already-inspected rows through the full path.
        const row = rows.at(-1)!
        const input = row.materializeInput()
        if (!input)
          throw new Error(
            'Skipped-row fallback could not build its full input.',
          )
        const receipt = await this.processEvent(input, input.received_at_ms)
        if (!receipt || receipt.status !== 'committed')
          throw new Error(
            'Skipped-row fallback did not obtain a committed receipt.',
          )
        const workId = this.durableStore!.getCommittedReplayWorkIdForSource(
          this.runId,
          row.rowid,
        )
        if (!workId)
          throw new Error(
            'Committed fallback source is missing its durable replay binding.',
          )
        this.commitProcessedSource({
          rowid: row.rowid,
          fromRowid: progress.cursorRowid + 1,
          inspectedRowCount: pendingSkippedInspectedCount,
          workId,
          sourceClock: row.sourceClock,
        })
        inspectedSinceProgress = 0
        pendingSkippedInspectedCount = 0
      }
    }
    for (const [index, source] of eligible.entries()) {
      if (stopRequested?.()) {
        await flushSkipped()
        stopped = true
        deferredSourceRows = eligible.length - index
        break
      }
      const receivedAt = Number(source.receivedAt)
      const sourceSequence = Number(source.receivedSequence)
      const control = controlForSource?.(source)
      const projectionAdvanced = this.applyMarketProjectionRow(
        source,
        receivedCutoff,
      )
      const requiredSourceEvent = this.isRequiredMarketSourceEvent(
        source,
        store,
        receivedAt,
        mode,
      )
      const materializeInput = () =>
        this.prepareMarketSourceInput(
          store,
          allEvents,
          source,
          instrument,
          mode,
          control,
        )
      let safeToSkip = false
      if (
        this.evaluationProgress &&
        projectionAdvanced &&
        control === undefined &&
        !requiredSourceEvent &&
        (source.type === 'book' || source.type === 'ticker') &&
        this.marketProjection
      ) {
        this.marketProjection.updateGapStatus(store.gapStatusAsOf(receivedAt))
        safeToSkip = this.canSkipIdleProjection({
          source,
          requiredSourceEvent,
          admission: this.admissionForSource?.(this.runId, receivedAt),
          sourceClock: receivedAt,
          projection: this.marketProjection.snapshotAt(receivedAt),
          control,
        })
      }
      if (safeToSkip) {
        inspectedSinceProgress += 1
        if (
          pendingSkipped.length > 0 &&
          sourceSequence !== pendingSkipped.at(-1)!.rowid + 1
        )
          await flushSkipped()
        pendingSkipped.push({
          rowid: sourceSequence,
          sourceClock: receivedAt,
          materializeInput,
        })
        pendingSkippedInspectedCount = inspectedSinceProgress
        if (pendingSkipped.length >= 128) await flushSkipped()
        continue
      }
      await flushSkipped()
      const input = materializeInput()
      if (!input) {
        if (!this.manifest.admission_policy)
          this.marketSourceCursor = sourceSequence
        else inspectedSinceProgress += 1
        continue
      }
      inspectedSinceProgress += 1
      const receipt = await this.processEvent(input, receivedAt)
      if (this.evaluationProgress) {
        if (!receipt || receipt.status !== 'committed')
          throw new Error(
            'Source cursor advances only after a committed financial receipt.',
          )
        const workId = this.durableStore!.getCommittedReplayWorkIdForSource(
          this.runId,
          sourceSequence,
        )
        if (!workId)
          throw new Error(
            'Committed source is missing its durable replay binding.',
          )
        this.commitProcessedSource({
          rowid: sourceSequence,
          fromRowid: this.evaluationProgress.cursorRowid + 1,
          inspectedRowCount: inspectedSinceProgress,
          workId,
          sourceClock: receivedAt,
        })
        inspectedSinceProgress = 0
      }
      this.marketSourceCursor = sourceSequence
    }
    await flushSkipped()
    this.marketSourcePending = this.marketSourcePending.filter(
      (event) => Number(event.receivedSequence) > this.marketSourceCursor,
    )
    return {
      sourceWatermark: this.marketSourceCursor,
      lastDurableWatermark: this.marketSourceCursor,
      stopped,
      deferredSourceRows,
      ...(() => {
        const pending = store.pendingEventsAfterAsOf(
          this.marketSourceCursor,
          receivedCutoff,
        )
        return {
          durablePendingSourceRows: pending.count,
          durablePendingFirstSequence: pending.firstSequence,
          durablePendingLastSequence: pending.lastSequence,
        }
      })(),
    }
  }

  private ensureMarketProjection(
    sourceEvents: Record<string, unknown>[],
  ): void {
    if (this.marketProjection || this.marketProjectionDisabled) return
    const first = sourceEvents[0]
    const firstSequence = first ? Number(first.receivedSequence) : undefined
    const baselineReceivedSequence =
      firstSequence === undefined
        ? this.marketSourceCursor
        : Math.min(this.marketSourceCursor, firstSequence - 1)
    const baselineKnownAtMs = first ? Number(first.receivedAt) : 0
    this.marketProjection = new IncrementalMarketProjection({
      baselineReceivedSequence,
      baselineKnownAtMs,
    })
    try {
      for (const source of sourceEvents) {
        const sequence = Number(source.receivedSequence)
        if (sequence > this.marketSourceCursor) break
        if (sequence > this.marketProjection.lastReceivedSequence)
          this.marketProjection.applySourceRow(source, Number.MAX_SAFE_INTEGER)
      }
    } catch {
      this.marketProjection = undefined
      this.marketProjectionDisabled = true
    }
  }

  private applyMarketProjectionRow(
    source: Record<string, unknown>,
    receivedCutoff: number,
  ): boolean {
    const projection = this.marketProjection
    if (!projection || this.marketProjectionDisabled) return false
    const sequence = Number(source.receivedSequence)
    if (
      !Number.isSafeInteger(sequence) ||
      sequence <= projection.lastReceivedSequence
    )
      return false
    try {
      projection.applySourceRow(source, receivedCutoff)
      return true
    } catch {
      this.marketProjection = undefined
      this.marketProjectionDisabled = true
      return false
    }
  }

  private isRequiredMarketSourceEvent(
    source: Record<string, unknown>,
    store: FuturesMarketStore,
    receivedAt: number,
    mode: 'mock' | 'paper_live' | 'replay',
  ): boolean {
    if (source.type === 'trade' || source.recovered === true) return true
    if (source.type !== 'ticker') return false
    if (source.fundingObservation !== undefined) return true
    const historicalFundingMode =
      mode === 'paper_live' ||
      (mode === 'replay' &&
        this.manifest.source === 'frozen-kraken-futures-market.v2')
    if (!historicalFundingMode) return false
    const covering = store.fundingForInterval(receivedAt, receivedAt)
    return (
      covering.length > 0 &&
      new Set(covering.map((record) => String(record.fundingRate))).size === 1
    )
  }

  private canSkipIdleProjection(input: {
    source: Record<string, unknown>
    requiredSourceEvent: boolean
    admission: Record<string, unknown> | undefined
    sourceClock: number
    projection: ReturnType<IncrementalMarketProjection['snapshotAt']>
    control: Record<string, unknown> | undefined
  }): boolean {
    return (
      input.control === undefined &&
      !input.requiredSourceEvent &&
      (input.source.type === 'book' || input.source.type === 'ticker') &&
      input.projection.eligible &&
      input.projection.gapStatusKnown &&
      input.projection.gapFree === true &&
      this.isSafeIdleAdmission(input.admission, input.sourceClock)
    )
  }

  private prepareMarketSourceInput(
    store: FuturesMarketStore,
    allEvents: Record<string, unknown>[],
    source: Record<string, unknown>,
    instrument: Record<string, unknown>,
    mode: 'mock' | 'paper_live' | 'replay',
    control: Record<string, unknown> | undefined,
  ): CausalInput | undefined {
    const receivedAt = Number(source.receivedAt)
    const sourceSequence = Number(source.receivedSequence)
    const preparationStarted = performance.now()
    this.emitTiming(
      'market-source-snapshot-preparation',
      'start',
      preparationStarted,
      sourceSequence,
      null,
    )
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
    const current = allEvents.filter(
      (event) =>
        Number(event.receivedSequence) <= sourceSequence &&
        Number(event.receivedAt) <= receivedAt,
    )
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
      const sequence = Number(event.receivedSequence)
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
          source_receipt_sequence: sequence,
          provider: 'kraken-futures',
          product_id: 'PF_XBTUSD',
          epoch: String(event.epoch),
          sequence,
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
          source_receipt_sequence: sequence,
          provider: 'kraken-futures',
          product_id: 'PF_XBTUSD',
          epoch: String(event.epoch),
          sequence,
          event_time_ms: eventAt,
          received_at_ms: known,
          known_at_ms: known,
          mark_usd: event.mark ?? event.last,
          market_status: event.suspended ? 'suspended' : 'open',
        })
        const historicalFundingMode =
          mode === 'paper_live' ||
          (mode === 'replay' &&
            this.manifest.source === 'frozen-kraken-futures-market.v2')
        if (!historicalFundingMode && event.fundingObservation) {
          marketEvents.push({
            type: 'funding_observation',
            received_at_ms: known,
            known_at_ms: known,
            observation: event.fundingObservation,
            reception_order: sequence,
          })
        }
        if (historicalFundingMode) {
          const covering = store.fundingForInterval(receivedAt, receivedAt)
          const rates = new Set(
            covering.map((record) => String(record.fundingRate)),
          )
          if (covering.length > 0 && rates.size === 1) {
            const evidence = covering.at(-1)!
            marketEvents.push({
              type: 'funding_observation',
              received_at_ms: Number(evidence.knownAtMs),
              known_at_ms: Number(evidence.knownAtMs),
              reception_order: sequence,
              observation: {
                source: 'kraken-historical-funding-rates.v1',
                provider: 'kraken',
                product: 'PF_XBTUSD',
                field: 'funding_rate',
                raw_rate: String(evidence.fundingRate),
                unit: 'usd_per_btc_per_hour',
                effective_start_ms: Number(evidence.startMs),
                effective_end_ms: Number(evidence.endMs),
                known_at_ms: Number(evidence.knownAtMs),
                received_seq: sequence,
                observation_id: `${String(evidence.sha256)}:${String(evidence.startMs)}`,
                sha256: String(evidence.sha256),
                semantic_version: 'kraken-funding-normalization.v1',
                predicted: false,
              },
            })
          }
        }
      } else if (event.type === 'trade') {
        marketEvents.push({
          type: event.recovered === true ? 'recovered_trade_audit' : 'trade',
          source_receipt_sequence: sequence,
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
    ) {
      this.emitTiming(
        'market-source-snapshot-preparation',
        'end',
        preparationStarted,
        sourceSequence,
        null,
      )
      return undefined
    }
    const input: CausalInput = {
      sequence: sourceSequence,
      received_at_ms: receivedAt,
      event_time_ms: Number(source.eventTime),
      known_at_ms: receivedAt,
      payload: {
        market_event: source,
        market_source_watermark: sourceSequence,
        market_gaps: structuredClone(gaps),
        market_snapshot: {
          mode,
          instrument,
          decision_time_ms: receivedAt,
          cutoff_received_at_ms: receivedAt,
          events: marketEvents,
        },
        ...(control ? { control } : {}),
      },
    }
    this.emitTiming(
      'market-source-snapshot-preparation',
      'end',
      preparationStarted,
      sourceSequence,
      null,
    )
    return input
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
      Boolean(this.manifest.admission_policy) !==
        Boolean(runtimeBinding.admission_policy) ||
      (this.manifest.admission_policy !== undefined &&
        canonicalHash(this.manifest.admission_policy) !==
          canonicalHash(runtimeBinding.admission_policy))
    )
      throw new Error(
        'Replay admission policy differs from the frozen runtime binding.',
      )
    if (
      sourceStore &&
      !this.manifest.source.startsWith('kraken-public-live-stream.')
    ) {
      const sourceHash = canonicalHash({
        events: sourceStore.eventsAsOf(Number.MAX_SAFE_INTEGER),
        candles: sourceStore.candlesAsOf(Number.MAX_SAFE_INTEGER),
        gaps: sourceStore.gapsAsOf(Number.MAX_SAFE_INTEGER),
        ...(this.manifest.source === 'frozen-kraken-futures-market.v2'
          ? { funding: sourceStore.fundingSourceEvidence() }
          : {}),
      })
      if (sourceHash !== this.manifest.source_hash)
        throw new Error(
          'Replay dataset hash does not match the frozen manifest.',
        )
      if (
        (this.manifest.source_metadata_hash !== undefined &&
          canonicalHash(sourceStore.instrumentVersions()) !==
            this.manifest.source_metadata_hash) ||
        (this.manifest.source_quality_hash !== undefined &&
          canonicalHash(sourceStore.qualityPolicies()) !==
            this.manifest.source_quality_hash)
      )
        throw new Error(
          'Replay catalog or quality policy does not match the frozen manifest.',
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
    if (this.manifest.admission_policy && sourceStore) {
      const policyIdentity = this.manifest.admission_policy.hash
      const sourceIdentity = canonicalHash({
        schema_version: 'futures-market-source-binding.v1',
        source: this.manifest.source,
        source_hash: this.manifest.source_hash,
      })
      const existing = this.durableStore.getEvaluationProgress(this.runId)
      if (!existing)
        this.durableStore.bindEvaluationProgress({
          runId: this.runId,
          policyIdentity,
          sourceIdentity,
          baselineRowid: 0,
          nextDueAt: null,
          nextDueReasons: [],
        })
      this.evaluationProgress = this.durableStore.getEvaluationProgress(
        this.runId,
      )
      if (
        !this.evaluationProgress ||
        this.evaluationProgress.policyIdentity !== policyIdentity ||
        this.evaluationProgress.sourceIdentity !== sourceIdentity
      )
        throw new Error(
          'Durable source progress does not match the bound run manifest.',
        )
      this.marketSourceCursor = this.evaluationProgress.cursorRowid
    }
  }

  private isSafeIdleAdmission(
    admission: Record<string, unknown> | undefined,
    sourceClock: number,
  ): boolean {
    if (!admission || !this.manifest.admission_policy) return false
    const due = isRecord(admission.next_due_at)
      ? admission.next_due_at
      : undefined
    const position = isRecord(admission.ledger_position)
      ? admission.ledger_position
      : undefined
    const risk = isRecord(admission.outstanding_risk)
      ? admission.outstanding_risk
      : undefined
    const pending = isRecord(admission.pending_commands)
      ? admission.pending_commands
      : undefined
    const entryBlockCauses = admission.entry_block_causes
    const financialObligations = admission.financial_obligations
    const fundingOnlyPause =
      Array.isArray(entryBlockCauses) &&
      entryBlockCauses.length > 0 &&
      entryBlockCauses.every(
        (cause) =>
          cause === 'funding_unavailable' ||
          cause === 'funding_accounting_incomplete',
      ) &&
      Array.isArray(financialObligations) &&
      financialObligations.length === 0
    return (
      admission.policy_hash ===
        canonicalHash({
          schema_version: this.manifest.admission_policy.schema_version,
          evaluation_interval_ms:
            this.manifest.admission_policy.evaluation_interval_ms,
        }) &&
      admission.run_id === this.runId &&
      admission.source_clock_ms === sourceClock &&
      admission.may_omit_entry_evaluation === true &&
      admission.execution_required === false &&
      position?.known === true &&
      position.value === null &&
      admission.active_order_count === 0 &&
      risk?.known === true &&
      risk.position === false &&
      risk.protection === false &&
      (risk.controls_active === false || fundingOnlyPause) &&
      pending?.known === true &&
      pending.any === false &&
      admission.in_flight_work_count === 0 &&
      due !== undefined &&
      Number.isSafeInteger(due.time_ms) &&
      Number(due.time_ms) > sourceClock &&
      Array.isArray(due.reasons) &&
      due.reasons.length > 0 &&
      Array.isArray(due.unknown_reasons) &&
      due.unknown_reasons.length === 0
    )
  }

  private commitProcessedSource(input: {
    rowid: number
    fromRowid: number
    inspectedRowCount: number
    workId: string
    sourceClock: number
  }): void {
    const progress = this.evaluationProgress!
    const head = this.durableStore!.getAdmissionHead(this.runId)
    if (!head)
      throw new Error('Financial head disappeared after source processing.')
    const state = this.admissionForSource?.(this.runId, input.sourceClock)
    const due =
      state && isRecord(state.next_due_at) ? state.next_due_at : undefined
    this.durableStore!.commitEvaluationProcessedSource({
      runId: this.runId,
      expectedPolicyIdentity: progress.policyIdentity,
      expectedSourceIdentity: progress.sourceIdentity,
      expectedStateVersion: head.stateVersion,
      expectedHeadHash: head.headHash,
      fromRowid: input.fromRowid,
      sourceRowid: input.rowid,
      inspectedRowCount: input.inspectedRowCount,
      workId: input.workId,
      nextDueAt:
        due && Number.isSafeInteger(due.time_ms) ? Number(due.time_ms) : null,
      nextDueReasons:
        due && Array.isArray(due.reasons)
          ? [
              ...(due.reasons as string[]),
              ...(Array.isArray(due.unknown_reasons)
                ? (due.unknown_reasons as string[])
                : []),
            ]
          : ['due_clock_unknown'],
    })
    this.evaluationProgress = { ...progress, cursorRowid: input.rowid }
    this.marketSourceCursor = input.rowid
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
      driver.restoreMarketSourceCursor(input)
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
          const appliedStateVersion = Number(persisted.applied_state_version)
          const economicProjection =
            options.durableStore.getAppliedRuntimeProjection(
              options.runId,
              work.work_id,
              appliedStateVersion,
            )
          const receipt: RuntimeReceipt = {
            status: persisted.status as RuntimeReceipt['status'],
            applied_state_version: appliedStateVersion,
            economic_projection: {
              runtime_output: economicProjection.runtime_output,
              ledger: economicProjection.ledger,
            },
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
    if (restored.works.length === 0)
      driver.stateVersion = Number(
        options.durableStore.getRunProjection(options.runId)?.state_version ??
          0,
      )
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
      driver.restoreMarketSourceCursor(input)
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

  private restoreMarketSourceCursor(input: CausalInput): void {
    const watermark = Number(input.payload.market_source_watermark)
    if (Number.isSafeInteger(watermark) && watermark >= 0)
      this.marketSourceCursor = Math.max(this.marketSourceCursor, watermark)
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
      mode?: 'mock' | 'paper_live' | 'replay'
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
      options.mode,
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
  if (left === undefined || right === undefined) return [prefix || '$']
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
  if (
    manifest.admission_policy !== undefined &&
    (manifest.admission_policy.schema_version !==
      'futures-entry-admission.v1' ||
      manifest.admission_policy.evaluation_interval_ms !== 5000 ||
      manifest.admission_policy.hash !==
        canonicalHash({
          schema_version: 'futures-entry-admission.v1',
          evaluation_interval_ms: 5000,
        }))
  )
    throw new Error('Replay manifest admission policy is invalid.')
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
