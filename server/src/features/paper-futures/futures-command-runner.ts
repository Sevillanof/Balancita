import { isDeepStrictEqual } from 'node:util'
import {
  FuturesStore,
  type FuturesSqlObserver,
  type TerminalCommandMetadata,
} from './futures-store.ts'
import {
  FuturesWorker,
  type FuturesWorkerCommit,
  type FuturesWorkerDiagnostic,
  type FuturesWorkerRequest,
  type FuturesWorkerResult,
  validateFuturesWorkerRequest,
} from './futures-worker.ts'
import { canonicalHash } from './futures-canonical.ts'
import {
  MARKET_CONTEXT_SCHEMA_VERSION,
  validateMarketContextTransport,
} from './futures-market-context.ts'

export type FuturesAdmissionPolicy = Readonly<{
  schema_version: 'futures-entry-admission.v1'
  evaluation_interval_ms: 5000
}>

export type FuturesAdmissionState = Readonly<
  Record<string, unknown> & {
    schema_version: 'futures-admission-state.v1'
    policy_hash: string
    run_id: string
    source_clock_ms: number | null
    confirmed_state_version: number | null
    head_hash: string | null
    last_applied_source_seq: number | null
    ledger_position: { known: boolean; value: Record<string, unknown> | null }
    active_order_count: number | null
    outstanding_risk: {
      known: boolean
      position: boolean | null
      protection: boolean | null
      controls_active: boolean | null
      reduction_intent_id: string | null
    }
    entry_block_causes: string[] | null
    financial_obligations: Record<string, unknown>[] | null
    execution_required: boolean
    may_omit_entry_evaluation: boolean
    in_flight_work_count: number
    pending_commands: { known: boolean; any: boolean | null }
    strategy_selection_due_at: {
      time_ms: number
      reason: 'strategy_evaluation'
    } | null
    next_due_at: {
      time_ms: number | null
      reasons: string[]
      unknown_reasons: string[]
    }
  }
>

const INSTRUMENT_ID = 'kraken-futures:PF_XBTUSD'
const COST_VERSION = 'kraken-futures-eea-btcusd-base.v1'
const VERIFIED_DUE = Symbol('verified-due')

/** Accepts commands durably before scheduling their deterministic ledger fixture. */
export class FuturesCommandRunner {
  private readonly worker: FuturesWorker
  private readonly inFlight = new Map<
    string,
    Promise<Record<string, unknown>>
  >()
  private readonly inFlightRuns = new Map<string, string>()
  private readonly admissionCache = new Map<
    string,
    { stateVersion: number; headHash: string; state: FuturesAdmissionState }
  >()
  private readonly store: FuturesStore
  private readonly sqlObserver?: FuturesSqlObserver

  constructor(
    store: FuturesStore,
    options: {
      readonly observer?: FuturesSqlObserver
      readonly workerObserver?: (event: FuturesWorkerDiagnostic) => void
    } = {},
  ) {
    this.store = store
    this.sqlObserver = options.observer
    this.worker = new FuturesWorker({
      observer: options.workerObserver,
      eventLoopSampleIntervalMs:
        process.env.BALANCITA_WORKER_EVENT_LOOP_INTERVAL_MS === undefined
          ? undefined
          : Number(process.env.BALANCITA_WORKER_EVENT_LOOP_INTERVAL_MS),
      commitResult: (result, request) => this.commit(result, request),
    })
  }

  accept(
    request: FuturesWorkerRequest,
    terminalCommand?: TerminalCommandMetadata,
  ): {
    readonly acknowledgement: Record<string, unknown>
    readonly result: Promise<Record<string, unknown>>
  } {
    return this.acceptInternal(request, terminalCommand)
  }

  /**
   * Accept a source-free execution decision when frozen admission state proves
   * that financial work is due. Callers must drain/check pending source rows
   * before invoking this method; queue ownership belongs to the session layer.
   */
  acceptDue(
    request: FuturesWorkerRequest,
    policy: FuturesAdmissionPolicy,
    decisionClock: number,
  ): {
    readonly acknowledgement: Record<string, unknown>
    readonly result: Promise<Record<string, unknown>>
  } {
    const existing = this.store.getAcceptedCommand(request.work_id)
    if (existing !== undefined) {
      const queued = parseQueuedCommand(existing, request.work_id)
      const reconstructed = this.prepareAcceptedMarketContext(
        request,
        undefined,
        queued.checkpoint,
        VERIFIED_DUE,
      )
      if (
        !queued.checkpoint ||
        !this.hasDueOrderDeadline(
          reconstructed,
          queued.checkpoint,
          decisionClock,
        ) ||
        !isDeepStrictEqual(reconstructed, queued.request)
      )
        throw new Error('Due work identity conflicts with its durable request.')
      const acknowledgement = this.store.acceptCommand(
        request.work_id,
        queued.request,
        undefined,
        queued.checkpoint,
      )
      const result = this.store.getCommandResult(request.work_id)
      if (result) return { acknowledgement, result: Promise.resolve(result) }
    }
    if (
      request.payload.operation !== 'futures_runtime.v3' ||
      request.payload.runtime_config.market_context_policy_version !==
        MARKET_CONTEXT_SCHEMA_VERSION ||
      !Number.isSafeInteger(decisionClock) ||
      request.payload.market_snapshot.cutoff_received_at_ms !== decisionClock ||
      request.payload.market_snapshot.decision_time_ms !== decisionClock ||
      request.payload.market_snapshot.market_context !== undefined ||
      !Array.isArray(request.payload.market_snapshot.events) ||
      request.payload.market_snapshot.events.length !== 0
    )
      throw new Error(
        'A due request requires a marked runtime and decision clock.',
      )
    const binding = this.store.getRuntimeBinding(request.run_id)
    if (
      !binding ||
      binding.schema_version !== 'futures-runtime-binding.v5' ||
      !isDeepStrictEqual(
        binding.runtime_config,
        request.payload.runtime_config,
      ) ||
      !isDeepStrictEqual(binding.instrument_spec, request.payload.instrument)
    )
      throw new Error('Due request requires its frozen runtime binding.')
    if (
      !isRecord(binding.admission_policy) ||
      binding.admission_policy.schema_version !== policy.schema_version ||
      binding.admission_policy.evaluation_interval_ms !==
        policy.evaluation_interval_ms ||
      binding.admission_policy.hash !== canonicalHash(policy)
    )
      throw new Error('Due request conflicts with frozen admission policy.')
    const projection = this.store.getRunProjection(request.run_id)
    const checkpoint = isRecord(projection?.checkpoint)
      ? (projection.checkpoint as Record<string, unknown>)
      : null
    const priorContext = isRecord(checkpoint?.market_context_checkpoint)
      ? checkpoint.market_context_checkpoint
      : undefined
    if (
      !checkpoint ||
      !priorContext ||
      priorContext.policy_version !== MARKET_CONTEXT_SCHEMA_VERSION ||
      priorContext.instrument_id !== request.payload.instrument.instrument_id ||
      typeof priorContext.source_identity !== 'string' ||
      !Number.isSafeInteger(priorContext.frontier) ||
      !isRecord(priorContext.anchors)
    )
      throw new Error('Due work requires a verified source-bound checkpoint.')
    if (!this.hasDueOrderDeadline(request, checkpoint, decisionClock))
      throw new Error('Due request has no persisted supported deadline.')
    const admission = this.readAdmissionState(
      request.run_id,
      policy,
      decisionClock,
    )
    const dueReduction = this.hasDueReductionOrder(checkpoint, decisionClock)
    const positionOpen = isRecord(checkpoint.ledger_position)
    const fundingBoundaryOnly =
      admission.next_due_at.unknown_reasons.length > 0 &&
      admission.next_due_at.unknown_reasons.every(
        (reason) => reason === 'funding_boundary_unknown',
      )
    const fundingBlocksEntry =
      admission.entry_block_causes?.some((cause) =>
        ['funding_unavailable', 'funding_accounting_incomplete'].includes(
          cause,
        ),
      ) ?? false
    if (
      admission.confirmed_state_version !== request.expected_state_version ||
      admission.source_clock_ms !== decisionClock ||
      admission.next_due_at.time_ms === null ||
      admission.next_due_at.time_ms > decisionClock ||
      (admission.next_due_at.unknown_reasons.length !== 0 &&
        !(fundingBoundaryOnly && (dueReduction || positionOpen))) ||
      (fundingBlocksEntry &&
        admission.next_due_at.reasons.some(
          (reason) => reason === 'strategy_evaluation',
        ) &&
        !dueReduction &&
        !positionOpen &&
        admission.active_order_count === 0) ||
      admission.next_due_at.reasons.length === 0 ||
      admission.next_due_at.reasons.some(
        (reason) =>
          ![
            'order_eligibility',
            'order_expiry',
            'strategy_evaluation',
            'utc_risk_day_rollover',
            'funding_boundary',
          ].includes(reason),
      ) ||
      admission.in_flight_work_count !== 0 ||
      admission.pending_commands.any !== false
    )
      throw new Error('Verified admission state does not prove due work.')
    return this.acceptInternal(request, undefined, VERIFIED_DUE)
  }

  private acceptInternal(
    request: FuturesWorkerRequest,
    terminalCommand?: TerminalCommandMetadata,
    dueCapability?: typeof VERIFIED_DUE,
  ): {
    readonly acknowledgement: Record<string, unknown>
    readonly result: Promise<Record<string, unknown>>
  } {
    if (request.checkpoint !== undefined)
      throw new Error(
        'Futures command checkpoint is assigned by the Node store.',
      )
    let checkpoint: Record<string, unknown> | null
    const binding = this.store.getRuntimeBinding(request.run_id)
    if (
      request.payload.operation === 'futures_runtime.v1' ||
      request.payload.operation === 'futures_runtime.v2' ||
      request.payload.operation === 'futures_runtime.v3'
    ) {
      const expectedBinding =
        request.payload.operation === 'futures_runtime.v3'
          ? binding?.schema_version === 'futures-runtime-binding.v5'
            ? 'futures-runtime-binding.v5'
            : 'futures-runtime-binding.v4'
          : request.payload.operation === 'futures_runtime.v2'
            ? 'futures-runtime-binding.v3'
            : request.payload.runtime_config.version ===
                'futures-runtime-strategies.v1'
              ? 'futures-runtime-binding.v2'
              : 'futures-runtime-binding.v1'
      if (!binding)
        throw new Error(
          'C27 runtime request requires a frozen runtime binding.',
        )
      if (
        binding.schema_version !== expectedBinding ||
        !isDeepStrictEqual(
          request.payload.runtime_config,
          binding.runtime_config,
        ) ||
        !isDeepStrictEqual(request.payload.instrument, binding.instrument_spec)
      )
        throw new Error(
          'C27 runtime request conflicts with frozen run binding.',
        )
      checkpoint =
        (this.store.getRunProjection(request.run_id)?.checkpoint as Record<
          string,
          unknown
        > | null) ?? null
    } else {
      if (binding)
        throw new Error(
          'Futures command operation does not match frozen run binding.',
        )
      checkpoint =
        (this.store.getRunProjection(request.run_id)?.result as Record<
          string,
          unknown
        > | null) ?? null
    }
    request = this.prepareAcceptedMarketContext(
      request,
      terminalCommand,
      checkpoint,
      dueCapability,
    )
    this.validateAcceptedMarketContext(
      request,
      terminalCommand,
      checkpoint,
      dueCapability,
    )
    validateFuturesWorkerRequest(request)
    const acknowledgement = this.store.acceptCommand(
      request.work_id,
      request,
      undefined,
      checkpoint,
      terminalCommand,
    )
    const existingResult = this.store.getCommandResult(request.work_id)
    if (existingResult)
      return { acknowledgement, result: Promise.resolve(existingResult) }
    const queued = parseQueuedCommand(
      this.store.getAcceptedCommand(request.work_id),
      request.work_id,
    )
    const result = this.startOrJoin(queued.request, queued.checkpoint)
    return { acknowledgement, result }
  }

  private validateAcceptedMarketContext(
    request: FuturesWorkerRequest,
    terminalCommand: TerminalCommandMetadata | undefined,
    checkpoint: Record<string, unknown> | null,
    dueCapability?: typeof VERIFIED_DUE,
  ): void {
    if (
      request.payload.operation !== 'futures_runtime.v3' ||
      request.payload.runtime_config.market_context_policy_version !==
        MARKET_CONTEXT_SCHEMA_VERSION
    )
      return
    const snapshot = request.payload.market_snapshot
    const context = snapshot.market_context
    if (
      !validateMarketContextTransport(context) ||
      context.instrument_id !== request.payload.instrument.instrument_id ||
      context.knowledge_cutoff_ms !== snapshot.cutoff_received_at_ms
    )
      throw new Error('Accepted market context is missing or invalid.')
    const acceptedControl =
      request.payload.control !== undefined &&
      isRecord(request.payload.control) &&
      terminalCommand !== undefined &&
      terminalCommand.command_id === request.work_id &&
      terminalCommand.action === request.payload.control.type &&
      terminalCommand.stream_run_id === request.run_id &&
      terminalCommand.expected_state_version ===
        request.expected_state_version &&
      request.payload.control.command_id === request.work_id &&
      ['paper.pause', 'paper.resume', 'paper.close'].includes(
        terminalCommand.action,
      )
    const acceptedNewRun =
      terminalCommand?.action === 'paper.new_run' &&
      terminalCommand.command_id === request.work_id &&
      terminalCommand.child_run_id === request.run_id &&
      terminalCommand.expected_state_version ===
        request.expected_state_version &&
      request.expected_state_version === 0 &&
      this.store.getRunProjection(request.run_id)?.state_version === 0
    const priorContext = isRecord(checkpoint?.market_context_checkpoint)
      ? checkpoint.market_context_checkpoint
      : undefined
    const previousFrontier = priorContext ? priorContext.frontier : 0
    if (context.previous_frontier !== previousFrontier)
      throw new Error('Accepted market context frontier is discontinuous.')
    if (context.source_identity === null) {
      const unboundPrior =
        priorContext?.source_identity === null &&
        priorContext.frontier === 0 &&
        isRecord(priorContext.anchors) &&
        Object.keys(priorContext.anchors).length === 0
      const initialRun =
        priorContext === undefined &&
        checkpoint === null &&
        request.expected_state_version === 0 &&
        this.store.getRunProjection(request.run_id)?.state_version === 0
      if (
        (!acceptedControl && !acceptedNewRun) ||
        (!unboundPrior && !initialRun) ||
        context.current_frontier !== 0 ||
        context.bootstrap_events.length !== 0 ||
        context.delta_events.length !== 0 ||
        !Array.isArray(snapshot.events) ||
        snapshot.events.length !== 0
      )
        throw new Error(
          'Unbound market context is restricted to a cold flat control.',
        )
      return
    }
    const replayBinding = this.store.getReplaySessionBinding(request.run_id)
    const manifest = isRecord(replayBinding?.manifest)
      ? replayBinding.manifest
      : undefined
    if (!manifest)
      throw new Error('Source-bound market context requires a frozen manifest.')
    const expectedSourceIdentity = canonicalHash({
      schema_version: 'market-context-source-identity.v1',
      source: manifest.source,
      source_hash: manifest.source_hash,
      instrument_hash:
        manifest.instrument_hash ?? canonicalHash(request.payload.instrument),
    })
    const unboundPrior =
      priorContext?.source_identity === null &&
      priorContext.frontier === 0 &&
      isRecord(priorContext.anchors) &&
      Object.keys(priorContext.anchors).length === 0
    if (
      context.source_identity !== expectedSourceIdentity ||
      (priorContext &&
        !unboundPrior &&
        priorContext.source_identity !== expectedSourceIdentity) ||
      (unboundPrior && context.previous_frontier !== 0) ||
      (context.current_frontier === context.previous_frontier &&
        ((!acceptedControl && dueCapability !== VERIFIED_DUE) ||
          !isDeepStrictEqual(snapshot.events, context.bootstrap_events))) ||
      (context.current_frontier > context.previous_frontier &&
        context.delta_events.length === 0)
    )
      throw new Error(
        'Accepted market context source identity or progress is invalid.',
      )
  }

  private prepareAcceptedMarketContext(
    request: FuturesWorkerRequest,
    terminalCommand: TerminalCommandMetadata | undefined,
    checkpoint: Record<string, unknown> | null,
    dueCapability?: typeof VERIFIED_DUE,
  ): FuturesWorkerRequest {
    if (request.payload.operation !== 'futures_runtime.v3') return request
    const config = request.payload.runtime_config
    const acceptedControl =
      isRecord(request.payload.control) &&
      terminalCommand !== undefined &&
      terminalCommand.command_id === request.work_id &&
      terminalCommand.action === request.payload.control.type &&
      terminalCommand.stream_run_id === request.run_id &&
      terminalCommand.expected_state_version ===
        request.expected_state_version &&
      request.payload.control.command_id === request.work_id &&
      ['paper.pause', 'paper.resume', 'paper.close'].includes(
        terminalCommand.action,
      )
    const acceptedNewRun =
      terminalCommand?.action === 'paper.new_run' &&
      terminalCommand.command_id === request.work_id &&
      terminalCommand.child_run_id === request.run_id &&
      terminalCommand.expected_state_version ===
        request.expected_state_version &&
      request.expected_state_version === 0 &&
      this.store.getRunProjection(request.run_id)?.state_version === 0
    if (
      config.market_context_policy_version !== MARKET_CONTEXT_SCHEMA_VERSION ||
      request.payload.market_snapshot.market_context !== undefined ||
      (!acceptedControl && !acceptedNewRun && dueCapability !== VERIFIED_DUE) ||
      !Array.isArray(request.payload.market_snapshot.events) ||
      request.payload.market_snapshot.events.length !== 0
    )
      return request

    const priorCheckpoint = isRecord(checkpoint?.market_context_checkpoint)
      ? checkpoint.market_context_checkpoint
      : undefined
    const replayBinding = this.store.getReplaySessionBinding(request.run_id)
    const manifest = isRecord(replayBinding?.manifest)
      ? replayBinding.manifest
      : undefined
    const priorUnbound =
      priorCheckpoint?.policy_version === MARKET_CONTEXT_SCHEMA_VERSION &&
      priorCheckpoint.source_identity === null &&
      priorCheckpoint.frontier === 0 &&
      isRecord(priorCheckpoint.anchors) &&
      Object.keys(priorCheckpoint.anchors).length === 0
    const projection = this.store.getRunProjection(request.run_id)
    const coldStart =
      !priorCheckpoint &&
      checkpoint === null &&
      request.expected_state_version === 0 &&
      projection?.state_version === 0
    let sourceIdentity: string | null
    let frontier: number
    let anchors: Record<string, unknown>[]
    if (coldStart || priorUnbound) {
      if (
        priorUnbound &&
        priorCheckpoint?.instrument_id !==
          request.payload.instrument.instrument_id
      )
        return request
      sourceIdentity = null
      frontier = 0
      anchors = []
    } else {
      if (
        !priorCheckpoint ||
        priorCheckpoint.policy_version !== MARKET_CONTEXT_SCHEMA_VERSION ||
        priorCheckpoint.instrument_id !==
          request.payload.instrument.instrument_id ||
        typeof priorCheckpoint.source_identity !== 'string' ||
        !Number.isSafeInteger(priorCheckpoint.frontier) ||
        !isRecord(priorCheckpoint.anchors) ||
        !manifest
      )
        return request
      const expectedSourceIdentity = canonicalHash({
        schema_version: 'market-context-source-identity.v1',
        source: manifest.source,
        source_hash: manifest.source_hash,
        instrument_hash:
          manifest.instrument_hash ?? canonicalHash(request.payload.instrument),
      })
      if (priorCheckpoint.source_identity !== expectedSourceIdentity)
        return request
      sourceIdentity = expectedSourceIdentity
      frontier = Number(priorCheckpoint.frontier)
      const cutoffForAnchors = Number(
        request.payload.market_snapshot.cutoff_received_at_ms,
      )
      anchors = Object.values(priorCheckpoint.anchors).filter(
        (event) =>
          isRecord(event) &&
          event.context_anchor === true &&
          Number.isSafeInteger(event.source_receipt_sequence) &&
          Number(event.source_receipt_sequence) <= frontier &&
          Number.isSafeInteger(event.known_at_ms) &&
          Number(event.known_at_ms) <= cutoffForAnchors &&
          Number.isSafeInteger(event.received_at_ms) &&
          Number(event.received_at_ms) <= cutoffForAnchors,
      ) as Record<string, unknown>[]
    }
    const cutoff = Number(request.payload.market_snapshot.cutoff_received_at_ms)
    const context = {
      schema_version: MARKET_CONTEXT_SCHEMA_VERSION,
      source_identity: sourceIdentity,
      instrument_id: request.payload.instrument.instrument_id,
      previous_frontier: frontier,
      current_frontier: frontier,
      knowledge_cutoff_ms: cutoff,
      bootstrap_events: anchors,
      delta_events: [],
    }
    if (!validateMarketContextTransport(context))
      throw new Error(
        'Durable market context cannot bind accepted control work.',
      )
    const payload = {
      ...request.payload,
      market_snapshot: {
        ...request.payload.market_snapshot,
        events: anchors,
        market_context: context,
      },
    }
    return { ...request, payload } as FuturesWorkerRequest
  }

  async resumePending(): Promise<Record<string, unknown>[]> {
    const pending = this.store.loadPendingCommands()
    const results: Record<string, unknown>[] = []
    for (const command of pending) {
      const queued = parseQueuedCommand(command.payload, command.command_id)
      results.push(await this.startOrJoin(queued.request, queued.checkpoint))
    }
    return results
  }

  close(): Promise<void> {
    return this.worker.close()
  }

  readAdmissionState(
    runId: string,
    policy: FuturesAdmissionPolicy,
    sourceClock: number,
  ): FuturesAdmissionState {
    const policyHash = canonicalHash(policy)
    const failClosed = (
      reason: string,
      stateVersion: number | null = null,
      headHash: string | null = null,
      sourceSequence: number | null = null,
    ): FuturesAdmissionState =>
      deepFreeze({
        schema_version: 'futures-admission-state.v1',
        policy_hash: policyHash,
        run_id: runId,
        source_clock_ms: Number.isSafeInteger(sourceClock) ? sourceClock : null,
        confirmed_state_version: stateVersion,
        head_hash: headHash,
        last_applied_source_seq: sourceSequence,
        ledger_position: { known: false, value: null },
        active_order_count: null,
        outstanding_risk: {
          known: false,
          position: null,
          protection: null,
          controls_active: null,
          reduction_intent_id: null,
        },
        entry_block_causes: null,
        financial_obligations: null,
        execution_required: true,
        may_omit_entry_evaluation: false,
        in_flight_work_count: this.inFlightRunCount(runId),
        pending_commands: { known: false, any: null },
        strategy_selection_due_at: null,
        next_due_at: { time_ms: null, reasons: [], unknown_reasons: [reason] },
      })

    if (
      policy.schema_version !== 'futures-entry-admission.v1' ||
      policy.evaluation_interval_ms !== 5000 ||
      !Number.isSafeInteger(sourceClock) ||
      sourceClock < 0
    )
      return failClosed('unsupported_policy_or_source_clock')

    let head: ReturnType<FuturesStore['getAdmissionHead']>
    try {
      head = this.store.getAdmissionHead(runId)
    } catch {
      return failClosed('verified_head_unavailable')
    }
    if (
      !head ||
      !Number.isSafeInteger(head.stateVersion) ||
      typeof head.headHash !== 'string'
    )
      return failClosed('run_head_missing_or_invalid')

    let state = this.admissionCache.get(runId)?.state
    const cached = this.admissionCache.get(runId)
    if (
      !cached ||
      cached.stateVersion !== head.stateVersion ||
      cached.headHash !== head.headHash ||
      cached.state.policy_hash !== policyHash
    ) {
      let projection: Record<string, unknown> | undefined
      try {
        projection = this.store.getRunProjection(runId)
      } catch {
        return failClosed(
          'projection_verification_failed',
          head.stateVersion,
          head.headHash,
        )
      }
      if (
        !projection ||
        projection.state_version !== head.stateVersion ||
        !isRecord(projection.checkpoint) ||
        projection.checkpoint.run_id !== runId
      )
        return failClosed(
          'projection_or_checkpoint_missing',
          head.stateVersion,
          head.headHash,
        )
      const checkpoint = projection.checkpoint
      if (checkpoint.schema_version !== 3 && checkpoint.schema_version !== 4)
        return failClosed(
          'unsupported_checkpoint_schema',
          head.stateVersion,
          head.headHash,
        )
      const positionKnown =
        checkpoint.ledger_position === null ||
        isRecord(checkpoint.ledger_position)
      const execution = checkpoint.execution_checkpoint
      const orders =
        isRecord(execution) && isRecord(execution.orders)
          ? Object.values(execution.orders)
          : undefined
      let activeOrderCount: number | null = 0
      if (!orders) activeOrderCount = null
      else
        for (const order of orders) {
          if (!isRecord(order) || typeof order.state !== 'string') {
            activeOrderCount = null
            break
          }
          if (order.state === 'accepted' || order.state === 'partially_filled')
            activeOrderCount += 1
          else if (
            ![
              'filled',
              'cancelled',
              'canceled',
              'rejected',
              'expired',
            ].includes(order.state)
          ) {
            activeOrderCount = null
            break
          }
        }
      const protectionKnown =
        checkpoint.position_protection === null ||
        isRecord(checkpoint.position_protection)
      const rawRisk = checkpoint.risk_checkpoint
      const riskKnown =
        isRecord(rawRisk) &&
        [
          'daily_loss_latched',
          'entry_paused',
          'user_paused',
          'system_paused',
        ].every((key) => typeof rawRisk[key] === 'boolean') &&
        (rawRisk.reduction_intent_id === null ||
          typeof rawRisk.reduction_intent_id === 'string')
      const risk = riskKnown
        ? (checkpoint.risk_checkpoint as Record<string, unknown>)
        : undefined
      const riskControlsActive = riskKnown
        ? risk!.daily_loss_latched === true ||
          risk!.entry_paused === true ||
          risk!.user_paused === true ||
          risk!.system_paused === true ||
          risk!.reduction_intent_id !== null
        : null
      const fundingPolicy = isRecord(checkpoint.funding_policy_checkpoint)
        ? checkpoint.funding_policy_checkpoint
        : undefined
      const fundingContract =
        fundingPolicy?.contract_version === 'funding-separation.v1' &&
        fundingPolicy.version === 'funding-separation.v1' &&
        ['known', 'unknown'].includes(String(fundingPolicy.availability)) &&
        Array.isArray(fundingPolicy.entry_block_causes) &&
        fundingPolicy.entry_block_causes.every(
          (cause) => typeof cause === 'string',
        ) &&
        Array.isArray(fundingPolicy.pending_financial_obligations) &&
        fundingPolicy.pending_financial_obligations.every(isRecord)
      const entryBlockCauses = fundingContract
        ? (fundingPolicy.entry_block_causes as string[])
        : null
      const financialObligations = fundingContract
        ? (fundingPolicy.pending_financial_obligations as Record<
            string,
            unknown
          >[])
        : null
      const sourceSequence =
        this.store.getLastAppliedReplaySourceSequence(runId)
      const lastDecisionTime = this.store.getLastAppliedDecisionTime(runId)
      const runtimeBinding = this.store.getRuntimeBinding(runId)
      const runtimeConfig = runtimeBinding?.runtime_config
      const cadenceEnabled =
        isRecord(runtimeConfig) &&
        runtimeConfig.strategy_selection_policy_version ===
          'strategy-selection-cadence.v1'
      const due: { time: number; reason: string }[] = []
      const unknownReasons: string[] = []
      let strategySelectionDueAt: number | null = null
      if (cadenceEnabled) {
        const selection = checkpoint.strategy_selection_checkpoint
        if (
          runtimeConfig.strategy_selection_interval_ms !== 5000 ||
          !isRecord(selection) ||
          selection.policy_version !== 'strategy-selection-cadence.v1' ||
          selection.interval_ms !== 5000 ||
          selection.run_id !== runId ||
          (selection.last_selection_ms !== null &&
            (!Number.isSafeInteger(selection.last_selection_ms) ||
              (selection.last_selection_ms as number) < 0))
        ) {
          return failClosed(
            'strategy_selection_checkpoint_invalid',
            head.stateVersion,
            head.headHash,
            sourceSequence,
          )
        }
        const lastSelection = selection.last_selection_ms as number
        const dueAt =
          lastSelection === null
            ? sourceClock
            : lastSelection + runtimeConfig.strategy_selection_interval_ms
        if (!Number.isSafeInteger(dueAt))
          unknownReasons.push('strategy_evaluation_clock_invalid')
        else {
          strategySelectionDueAt = dueAt
          due.push({ time: dueAt, reason: 'strategy_evaluation' })
        }
      } else if (
        lastDecisionTime !== null &&
        Number.isSafeInteger(lastDecisionTime)
      )
        due.push({
          time: lastDecisionTime + policy.evaluation_interval_ms,
          reason: 'strategy_evaluation',
        })
      else unknownReasons.push('strategy_evaluation_clock_unknown')
      if (orders) {
        for (const order of orders) {
          if (!isRecord(order)) continue
          const activeOrder =
            order.state === 'accepted' || order.state === 'partially_filled'
          if (!activeOrder) continue
          let orderClockFound = false
          const eligibleAt = order.eligible_at_ms
          if (Number.isSafeInteger(eligibleAt)) {
            orderClockFound = true
            if (
              lastDecisionTime === null ||
              !Number.isSafeInteger(lastDecisionTime) ||
              Number(eligibleAt) > lastDecisionTime
            )
              due.push({
                time: Number(eligibleAt),
                reason: 'order_eligibility',
              })
          }
          const expiryAt = order.expiry_ms
          if (Number.isSafeInteger(expiryAt)) {
            due.push({ time: Number(expiryAt), reason: 'order_expiry' })
            orderClockFound = true
          }
          if (!orderClockFound)
            unknownReasons.push('active_order_clock_unknown')
        }
      }
      const riskCheckpoint = isRecord(checkpoint.risk_checkpoint)
        ? checkpoint.risk_checkpoint
        : undefined
      const utcDay = riskCheckpoint?.utc_day
      if (typeof utcDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(utcDay)) {
        const dayStart = Date.parse(`${utcDay}T00:00:00.000Z`)
        if (Number.isSafeInteger(dayStart))
          due.push({
            time: dayStart + 86_400_000,
            reason: 'utc_risk_day_rollover',
          })
        else unknownReasons.push('utc_risk_day_clock_invalid')
      } else {
        unknownReasons.push('utc_risk_day_clock_unknown')
      }
      if (activeOrderCount === null) unknownReasons.push('order_state_unknown')
      if (!riskKnown) unknownReasons.push('risk_checkpoint_unknown')
      if (!positionKnown) unknownReasons.push('ledger_position_unknown')
      if (!protectionKnown) unknownReasons.push('position_protection_unknown')
      if (checkpoint.ledger_position !== null) {
        const fundingBoundary = this.verifiedFundingBoundaryAt(
          checkpoint,
          lastDecisionTime,
          runtimeBinding?.instrument_spec,
        )
        if (fundingBoundary === null)
          unknownReasons.push('funding_boundary_unknown')
        else due.push({ time: fundingBoundary, reason: 'funding_boundary' })
      }
      const nextTime = due.length
        ? Math.min(...due.map((item) => item.time))
        : null
      const nextReasons =
        nextTime === null
          ? []
          : due
              .filter((item) => item.time === nextTime)
              .map((item) => item.reason)
      const position =
        positionKnown && isRecord(checkpoint.ledger_position)
          ? checkpoint.ledger_position
          : null
      const typedEntryOnlyPause =
        fundingContract &&
        entryBlockCauses!.length > 0 &&
        entryBlockCauses!.every((cause) =>
          ['funding_unavailable', 'funding_accounting_incomplete'].includes(
            cause,
          ),
        ) &&
        financialObligations!.length === 0 &&
        positionKnown &&
        position === null &&
        protectionKnown &&
        checkpoint.position_protection === null &&
        activeOrderCount === 0 &&
        riskKnown &&
        risk!.user_paused !== true &&
        risk!.daily_loss_latched !== true &&
        risk!.system_paused !== true &&
        risk!.reduction_intent_id === null &&
        risk!.mark_quality === 'valid'
      const executionRequired =
        !positionKnown ||
        !protectionKnown ||
        !riskKnown ||
        activeOrderCount === null ||
        position !== null ||
        checkpoint.position_protection !== null ||
        activeOrderCount > 0 ||
        (riskControlsActive !== false && !typedEntryOnlyPause)
      const pendingCommands = this.store.loadPendingCommands(1).length > 0
      const base = deepFreeze<FuturesAdmissionState>({
        schema_version: 'futures-admission-state.v1',
        policy_hash: policyHash,
        run_id: runId,
        source_clock_ms: sourceClock,
        confirmed_state_version: head.stateVersion,
        head_hash: head.headHash,
        last_applied_source_seq: sourceSequence,
        ledger_position: { known: positionKnown, value: position },
        active_order_count: activeOrderCount,
        outstanding_risk: {
          known: positionKnown && protectionKnown && riskKnown,
          position: positionKnown ? position !== null : null,
          protection: protectionKnown
            ? checkpoint.position_protection !== null
            : null,
          controls_active: riskControlsActive,
          reduction_intent_id:
            riskKnown && typeof risk!.reduction_intent_id === 'string'
              ? risk!.reduction_intent_id
              : null,
        },
        entry_block_causes: entryBlockCauses,
        financial_obligations: financialObligations,
        execution_required: executionRequired,
        may_omit_entry_evaluation:
          !executionRequired &&
          !pendingCommands &&
          this.inFlightRunCount(runId) === 0,
        in_flight_work_count: this.inFlightRunCount(runId),
        pending_commands: { known: true, any: pendingCommands },
        strategy_selection_due_at:
          strategySelectionDueAt === null
            ? null
            : {
                time_ms: strategySelectionDueAt,
                reason: 'strategy_evaluation',
              },
        next_due_at: {
          time_ms: nextTime,
          reasons: nextReasons,
          unknown_reasons: unknownReasons,
        },
      })
      state = base
      this.admissionCache.set(runId, {
        stateVersion: head.stateVersion,
        headHash: head.headHash,
        state: base,
      })
    }

    if (state!.source_clock_ms !== sourceClock)
      state = deepFreeze({ ...state!, source_clock_ms: sourceClock })

    const pending = this.store.loadPendingCommands(1).length > 0
    const inFlight = this.inFlightRunCount(runId)
    if (!pending && inFlight === 0) return state!
    return Object.freeze({
      ...state!,
      execution_required: true,
      may_omit_entry_evaluation: false,
      in_flight_work_count: inFlight,
      pending_commands: { known: true, any: pending },
    })
  }

  private inFlightRunCount(runId: string): number {
    let count = 0
    for (const activeRunId of this.inFlightRuns.values())
      if (activeRunId === runId) count += 1
    return count
  }

  private hasDueOrderDeadline(
    request: FuturesWorkerRequest,
    checkpoint: Record<string, unknown>,
    decisionClock: number,
  ): boolean {
    if (request.payload.operation !== 'futures_runtime.v3') return false
    const decisionTime = request.payload.market_snapshot.decision_time_ms
    if (!Number.isSafeInteger(decisionTime)) return false
    const execution = checkpoint.execution_checkpoint
    const orders =
      isRecord(execution) && isRecord(execution.orders)
        ? Object.values(execution.orders)
        : []
    const previousDecision =
      isRecord(execution) && Number.isSafeInteger(execution.last_cutoff_ms)
        ? Number(execution.last_cutoff_ms)
        : this.store.getLastAppliedDecisionTime(request.run_id)
    const dueOrder = orders.some(
      (order) =>
        isRecord(order) &&
        ['accepted', 'partially_filled'].includes(String(order.state)) &&
        ((Number.isSafeInteger(order.eligible_at_ms) &&
          Number(order.eligible_at_ms) <= Number(decisionTime) &&
          (previousDecision === null ||
            Number(order.eligible_at_ms) > previousDecision)) ||
          (Number.isSafeInteger(order.expiry_ms) &&
            Number(order.expiry_ms) <= Number(decisionTime))),
    )
    const risk = checkpoint.risk_checkpoint
    const utcDue =
      isRecord(risk) &&
      typeof risk.utc_day === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(risk.utc_day) &&
      Date.parse(`${risk.utc_day}T00:00:00.000Z`) + 86_400_000 <=
        Number(decisionTime)
    const selection = checkpoint.strategy_selection_checkpoint
    const selectionDue =
      isRecord(selection) &&
      selection.policy_version === 'strategy-selection-cadence.v1' &&
      selection.interval_ms === 5000 &&
      Number.isSafeInteger(selection.last_selection_ms) &&
      Number(selection.last_selection_ms) + 5000 <= Number(decisionTime)
    const fundingBoundary = this.verifiedFundingBoundaryAt(
      checkpoint,
      previousDecision,
      this.store.getRuntimeBinding(request.run_id)?.instrument_spec,
    )
    return (
      decisionTime === decisionClock &&
      (dueOrder ||
        utcDue ||
        selectionDue ||
        (fundingBoundary !== null && fundingBoundary <= Number(decisionTime)))
    )
  }

  private verifiedFundingBoundaryAt(
    checkpoint: Record<string, unknown>,
    lastDecisionTime: number | null,
    instrumentSpec: unknown,
  ): number | null {
    const position = checkpoint.ledger_position
    const policy = checkpoint.funding_policy_checkpoint
    const evidence = isRecord(policy) ? policy.evidence : undefined
    if (
      !isRecord(position) ||
      !isRecord(policy) ||
      !isRecord(evidence) ||
      !isRecord(instrumentSpec) ||
      policy.contract_version !== 'funding-separation.v1' ||
      policy.version !== 'funding-separation.v1' ||
      policy.availability !== 'known' ||
      evidence.status !== 'known' ||
      evidence.applicable_at_decision !== true ||
      evidence.reason !== null ||
      evidence.provider !== 'kraken' ||
      evidence.product !== 'PF_XBTUSD' ||
      evidence.field !== 'funding_rate' ||
      evidence.unit !== 'usd_per_btc_per_hour' ||
      evidence.semantic_version !== 'kraken-funding-normalization.v1' ||
      evidence.predicted !== false ||
      typeof evidence.observation_id !== 'string' ||
      !/^[a-f0-9]{64}$/.test(String(evidence.sha256)) ||
      instrumentSpec.instrument_id !== 'kraken-futures:PF_XBTUSD' ||
      checkpoint.instrument_id !== instrumentSpec.instrument_id ||
      checkpoint.funding_cursor_ms !== position.funding_cursor_ms ||
      !Number.isSafeInteger(lastDecisionTime) ||
      !Number.isSafeInteger(position.funding_cursor_ms) ||
      !Number.isSafeInteger(evidence.effective_start_ms) ||
      !Number.isSafeInteger(evidence.effective_end_ms) ||
      !Number.isSafeInteger(evidence.known_at_ms)
    )
      return null

    const start = Number(evidence.effective_start_ms)
    const end = Number(evidence.effective_end_ms)
    const knownAt = Number(evidence.known_at_ms)
    const cursor = Number(position.funding_cursor_ms)
    const decision = Number(lastDecisionTime)
    const recordedRate = Array.isArray(checkpoint.funding_rates)
      ? checkpoint.funding_rates.some(
          (rate) =>
            Array.isArray(rate) &&
            rate[0] === `${evidence.observation_id}:${evidence.sha256}` &&
            rate[1] === start &&
            rate[2] === end &&
            typeof rate[3] === 'string',
        )
      : false
    const openPositionObligation = Array.isArray(
      policy.pending_financial_obligations,
    )
      ? policy.pending_financial_obligations.some(
          (obligation) =>
            isRecord(obligation) && obligation.kind === 'open_position',
        )
      : false
    if (
      !recordedRate ||
      !openPositionObligation ||
      knownAt > start ||
      start > cursor ||
      cursor >= end ||
      start > decision ||
      decision >= end
    )
      return null
    return end
  }

  private hasDueReductionOrder(
    checkpoint: Record<string, unknown>,
    decisionClock: number,
  ): boolean {
    const execution = checkpoint.execution_checkpoint
    const orders =
      isRecord(execution) && isRecord(execution.orders)
        ? Object.values(execution.orders)
        : []
    return orders.some(
      (order) =>
        isRecord(order) &&
        ['accepted', 'partially_filled'].includes(String(order.state)) &&
        Number.isSafeInteger(order.eligible_at_ms) &&
        Number(order.eligible_at_ms) <= decisionClock &&
        isRecord(order.intent) &&
        order.intent.order_type === 'reduce_only',
    )
  }

  private async commit(
    result: FuturesWorkerResult,
    request: FuturesWorkerRequest,
  ): Promise<FuturesWorkerCommit> {
    if (
      request.payload.operation === 'futures_runtime.v3' &&
      request.payload.runtime_config.market_context_policy_version ===
        MARKET_CONTEXT_SCHEMA_VERSION
    ) {
      const context = request.payload.market_snapshot.market_context
      const contextCheckpoint =
        isRecord(result.runtime_checkpoint) &&
        isRecord(result.runtime_checkpoint.market_context_checkpoint)
          ? result.runtime_checkpoint.market_context_checkpoint
          : undefined
      const runBinding = this.store.getReplaySessionBinding(request.run_id)
      const manifest = isRecord(runBinding?.manifest)
        ? runBinding.manifest
        : undefined
      const expectedSourceIdentity = manifest
        ? canonicalHash({
            schema_version: 'market-context-source-identity.v1',
            source: manifest.source,
            source_hash: manifest.source_hash,
            instrument_hash:
              manifest.instrument_hash ??
              canonicalHash(request.payload.instrument),
          })
        : undefined
      const priorProjection = this.store.getRunProjection(request.run_id)
      const priorCheckpoint =
        isRecord(priorProjection?.checkpoint) &&
        isRecord(priorProjection.checkpoint.market_context_checkpoint)
          ? priorProjection.checkpoint.market_context_checkpoint
          : undefined
      const expectedPreviousFrontier = priorCheckpoint
        ? priorCheckpoint.frontier
        : 0
      const noSourceProgress =
        validateMarketContextTransport(context) &&
        context.current_frontier === context.previous_frontier
      const acceptedControl =
        request.payload.control !== undefined &&
        request.payload.control.command_id === request.work_id &&
        this.store.getAcceptedCommand(request.work_id) !== undefined
      const queuedCommand = this.store.getAcceptedCommand(request.work_id)
      const acceptedNewRun =
        isRecord(queuedCommand) &&
        isRecord(queuedCommand.terminalCommand) &&
        queuedCommand.terminalCommand.action === 'paper.new_run' &&
        queuedCommand.terminalCommand.command_id === request.work_id &&
        queuedCommand.terminalCommand.child_run_id === request.run_id &&
        queuedCommand.terminalCommand.expected_state_version === 0 &&
        request.expected_state_version === 0 &&
        priorProjection?.state_version === 0
      const queuedRequest =
        isRecord(queuedCommand) && isRecord(queuedCommand.request)
          ? queuedCommand.request
          : undefined
      const dueContext = validateMarketContextTransport(context)
        ? context
        : undefined
      const dueEvents = Array.isArray(request.payload.market_snapshot.events)
        ? request.payload.market_snapshot.events
        : undefined
      const durableRequest = { ...request }
      delete durableRequest.checkpoint
      const dueOrderWork =
        !request.payload.control &&
        queuedRequest !== undefined &&
        isDeepStrictEqual(queuedRequest, durableRequest) &&
        isRecord(queuedCommand) &&
        isDeepStrictEqual(
          queuedCommand.checkpoint,
          priorProjection?.checkpoint,
        ) &&
        priorProjection?.state_version === request.expected_state_version &&
        dueContext !== undefined &&
        dueEvents !== undefined &&
        dueEvents.length === dueContext.bootstrap_events.length &&
        isDeepStrictEqual(dueEvents, dueContext.bootstrap_events) &&
        dueContext.delta_events.length === 0 &&
        this.hasDueOrderDeadline(
          request,
          priorProjection?.checkpoint as Record<string, unknown>,
          Number(request.payload.market_snapshot.decision_time_ms),
        )
      const coldUnboundControl =
        noSourceProgress &&
        (acceptedControl || acceptedNewRun) &&
        context.source_identity === null &&
        context.current_frontier === 0
      if (
        !validateMarketContextTransport(context) ||
        context.instrument_id !== request.payload.instrument.instrument_id ||
        context.knowledge_cutoff_ms !==
          request.payload.market_snapshot.cutoff_received_at_ms ||
        (context.source_identity !== expectedSourceIdentity &&
          !coldUnboundControl) ||
        context.previous_frontier !== expectedPreviousFrontier ||
        (noSourceProgress &&
          (!(acceptedControl || acceptedNewRun || dueOrderWork) ||
            !Array.isArray(request.payload.market_snapshot.events) ||
            !isDeepStrictEqual(
              request.payload.market_snapshot.events,
              context.bootstrap_events,
            ))) ||
        (!noSourceProgress &&
          acceptedControl &&
          context.delta_events.length === 0) ||
        !contextCheckpoint ||
        contextCheckpoint.policy_version !== MARKET_CONTEXT_SCHEMA_VERSION ||
        contextCheckpoint.source_identity !== context.source_identity ||
        contextCheckpoint.instrument_id !== context.instrument_id ||
        contextCheckpoint.frontier !== context.current_frontier ||
        contextCheckpoint.knowledge_cutoff_ms !== context.knowledge_cutoff_ms
      )
        throw new Error(
          'Market-context input and returned checkpoint frontier differ.',
        )
    }
    if (
      (result.operation === 'futures_runtime.v1' ||
        result.operation === 'futures_runtime.v2' ||
        result.operation === 'futures_runtime.v3') &&
      result.operation === request.payload.operation &&
      result.runtime_event_time_ms !==
        request.payload.market_snapshot.decision_time_ms
    )
      throw new Error(
        'Python C27 runtime decision time does not match accepted work.',
      )
    const snapshot = result.result
    const events = toStoreEvents(result)
    const envelope =
      result.operation === 'futures_runtime.v1' ||
      result.operation === 'futures_runtime.v2' ||
      result.operation === 'futures_runtime.v3'
        ? {
            schema_version:
              result.operation === 'futures_runtime.v3'
                ? 'futures-runtime-work.v3'
                : result.operation === 'futures_runtime.v2'
                  ? 'futures-runtime-work.v2'
                  : 'futures-runtime-work.v1',
            protocol_version: 1,
            run_id: result.run_id,
            work_id: result.work_id,
            applied_state_version: result.applied_state_version,
            result: snapshot,
            events,
            runtime_output: result.runtime_output,
            runtime_checkpoint: result.runtime_checkpoint,
          }
        : {
            protocol_version: 1,
            run_id: result.run_id,
            work_id: result.work_id,
            applied_state_version: result.applied_state_version,
            result: snapshot,
            events,
          }
    const receipt = this.store.applyResult(
      envelope,
      undefined,
      this.sqlObserver
        ? { requestId: result.request_id, observer: this.sqlObserver }
        : undefined,
    )
    if (
      typeof receipt.result_hash !== 'string' ||
      (receipt.status !== 'committed' && receipt.status !== 'superseded') ||
      !Number.isSafeInteger(receipt.applied_state_version)
    )
      throw new Error(
        'Futures store returned an invalid durable acknowledgement.',
      )
    return {
      status: receipt.status,
      applied_state_version: receipt.applied_state_version as number,
      result_hash: receipt.result_hash,
    }
  }

  private async processAccepted(
    request: FuturesWorkerRequest,
    checkpoint: Record<string, unknown> | null,
  ): Promise<Record<string, unknown>> {
    this.store.recordWork({
      workId: request.work_id,
      runId: request.run_id,
      cycleKey: request.work_id,
      expectedVersion: request.expected_state_version,
      snapshot: { request, checkpoint },
    })
    const priorReceipt = this.store.getAppliedReceipt(request.work_id)
    if (priorReceipt)
      return this.store.persistCommandResult(request.work_id, priorReceipt)
    await this.worker.submit({ ...request, checkpoint })
    const receipt = this.store.getAppliedReceipt(request.work_id)
    if (!receipt)
      throw new Error('Worker commit acknowledgement has no persisted receipt.')
    return this.store.persistCommandResult(request.work_id, receipt)
  }

  private startOrJoin(
    request: FuturesWorkerRequest,
    checkpoint: Record<string, unknown> | null,
  ): Promise<Record<string, unknown>> {
    const existing = this.inFlight.get(request.work_id)
    if (existing) return existing
    const result = this.processAccepted(request, checkpoint).finally(() => {
      this.inFlight.delete(request.work_id)
      this.inFlightRuns.delete(request.work_id)
    })
    this.inFlight.set(request.work_id, result)
    this.inFlightRuns.set(request.work_id, request.run_id)
    return result
  }
}

function parseQueuedCommand(
  value: unknown,
  commandId: string,
): {
  request: FuturesWorkerRequest
  checkpoint: Record<string, unknown> | null
} {
  if (
    !isRecord(value) ||
    !isRecord(value.request) ||
    (value.checkpoint !== null && !isRecord(value.checkpoint))
  )
    throw new Error('Persisted futures command checkpoint is invalid.')
  const request = value.request as unknown as FuturesWorkerRequest
  if (request.work_id !== commandId)
    throw new Error(
      'Persisted futures command does not match its work identity.',
    )
  validateFuturesWorkerRequest(request)
  return { request, checkpoint: value.checkpoint }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>))
      deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function toStoreEvents(result: FuturesWorkerResult): Record<string, unknown>[] {
  if (
    result.operation === 'futures_runtime.v1' ||
    result.operation === 'futures_runtime.v2' ||
    result.operation === 'futures_runtime.v3'
  )
    return toRuntimeStoreEvents(result)
  if (!result.event_times_ms)
    throw new Error('Round-trip result omitted its event times.')
  const ledgerEvents = result.result.events
  if (!Array.isArray(ledgerEvents) || !ledgerEvents.every(isRecord))
    throw new Error('Python ledger audit events are invalid.')
  const opening = result.events.find((event) => event.type === 'open')
  const closing = [...result.events]
    .reverse()
    .find((event) => event.type === 'close')
  if (!opening || !closing)
    throw new Error(
      'Round-trip result must contain open and close audit events.',
    )
  const positionSide = opening.side
  if (positionSide !== 'long' && positionSide !== 'short')
    throw new Error('Ledger opening side is invalid.')
  const quantity = String(opening.qty)
  const common = {
    event_version: 1,
    run_id: result.run_id,
    work_id: result.work_id,
    instrument_id: INSTRUMENT_ID,
    cost_version: COST_VERSION,
  }
  const fill = (suffix: string, price: unknown, fee: unknown) => ({
    ...common,
    id: `${result.work_id}:${suffix}`,
    fill_id: `${result.work_id}:${suffix}`,
    type: 'fill',
    side: positionSide,
    quantity_btc: quantity,
    price_usd_per_btc: String(price),
    fee_usd: String(fee),
    liquidity: 'taker',
  })
  const account = result.result
  return [
    fill('open', opening.price, opening.fee),
    fill('close', result.result.mark_usd_per_btc, closing.exit_fee),
    {
      ...common,
      id: `${result.work_id}:position`,
      type: 'position',
      event_time_ms: result.event_times_ms.closed_at_ms,
      side: null,
      quantity_btc: '0',
    },
    {
      ...common,
      id: `${result.work_id}:account`,
      type: 'account',
      event_time_ms: result.event_times_ms.closed_at_ms,
      equity_usd: account.equity_usd,
      available_margin_usd: account.available_margin_usd,
      reserved_margin_usd: account.reserved_margin_usd,
      fees_usd: account.fees_usd,
      funding_paid: account.funding_paid,
    },
  ]
}

function toRuntimeStoreEvents(
  result: FuturesWorkerResult,
): Record<string, unknown>[] {
  const output = result.runtime_output
  const checkpoint = result.runtime_checkpoint
  if (
    !output ||
    !checkpoint ||
    !Number.isSafeInteger(result.runtime_event_time_ms)
  )
    throw new Error(
      'Python C27 runtime response is missing its checkpoint or decision time.',
    )
  if (
    !Array.isArray(output.fills) ||
    !isRecord(output.position) ||
    !isRecord(output.ledger)
  )
    throw new Error(
      'Python C27 runtime response has invalid financial projections.',
    )
  const common = {
    event_version: 1,
    run_id: result.run_id,
    work_id: result.work_id,
    instrument_id: INSTRUMENT_ID,
    cost_version: COST_VERSION,
  }
  const fills = output.fills.map((candidate) => {
    if (!isRecord(candidate) || typeof candidate.fill_id !== 'string')
      throw new Error('Python C27 runtime fill identity is invalid.')
    return {
      ...common,
      id: `${result.work_id}:fill:${candidate.fill_id}`,
      fill_id: `${result.work_id}:fill:${candidate.fill_id}`,
      type: 'fill',
      side: candidate.side,
      quantity_btc: candidate.quantity_btc,
      price_usd_per_btc: candidate.price_usd_per_btc,
      fee_usd: candidate.fee_usd,
      liquidity: candidate.liquidity,
    }
  })
  const orderEvents = (
    output.runtime_version === 'futures-runtime-execution.v1' ||
    output.runtime_version === 'futures-runtime-risk.v1'
      ? (output.orders as Record<string, unknown>[])
      : []
  ).flatMap((candidate: Record<string, unknown>) => {
    if (!isRecord(candidate) || typeof candidate.type !== 'string')
      throw new Error('Python runtime order event is invalid.')
    if (
      ![
        'order_created',
        'order_accepted',
        'order_filled',
        'cancelled',
        'rejected',
        'expired',
      ].includes(candidate.type)
    )
      return []
    const execution = result.runtime_checkpoint?.execution_checkpoint
    const savedOrder =
      isRecord(execution) &&
      isRecord(execution.orders) &&
      typeof candidate.order_id === 'string'
        ? execution.orders[candidate.order_id]
        : undefined
    const intent =
      isRecord(savedOrder) && isRecord(savedOrder.intent)
        ? savedOrder.intent
        : {}
    const orderType = candidate.order_type ?? intent.order_type
    const side = candidate.side ?? intent.side
    const quantity =
      candidate.quantity_btc ??
      candidate.filled_quantity_btc ??
      intent.quantity_btc
    if (
      typeof candidate.order_id !== 'string' ||
      typeof orderType !== 'string' ||
      typeof side !== 'string' ||
      typeof quantity !== 'string'
    )
      throw new Error('Python runtime order event is incomplete.')
    const eventTime =
      candidate.effective_at_ms ??
      candidate.decision_at_ms ??
      candidate.eligible_at_ms ??
      result.runtime_event_time_ms
    return [
      {
        ...common,
        id: `${result.work_id}:order:${String(candidate.event_id ?? candidate.order_id)}:${candidate.type}`,
        type: 'order',
        order_id: candidate.order_id,
        status: candidate.type,
        order_type: orderType,
        side,
        quantity_btc: quantity,
        event_time_ms: eventTime,
      },
    ]
  })
  const position = output.position
  const events: Record<string, unknown>[] = [
    ...fills,
    ...orderEvents,
    {
      ...common,
      id: `${result.work_id}:position`,
      type: 'position',
      event_time_ms: result.runtime_event_time_ms,
      side: position.side,
      quantity_btc: position.quantity_btc,
    },
  ]
  const ledger = output.ledger
  for (const name of [
    'equity_usd',
    'available_margin_usd',
    'reserved_margin_usd',
    'fees_usd',
    'funding_paid',
  ])
    if (typeof ledger[name] !== 'string')
      throw new Error(`Python C27 runtime ledger is missing ${name}.`)
  events.push({
    ...common,
    id: `${result.work_id}:account`,
    type: 'account',
    event_time_ms: result.runtime_event_time_ms,
    equity_usd: ledger.equity_usd,
    available_margin_usd: ledger.available_margin_usd,
    reserved_margin_usd: ledger.reserved_margin_usd,
    fees_usd: ledger.fees_usd,
    funding_paid: ledger.funding_paid,
  })
  const funding = result.runtime_funding_events
  if (!Array.isArray(funding))
    throw new Error('Python C27 funding audit is missing.')
  funding.forEach((item, index) => {
    if (!isRecord(item)) throw new Error('Python C27 funding audit is invalid.')
    events.push({
      ...item,
      ...common,
      id: `${result.work_id}:funding:${index}`,
      type: 'funding',
    })
  })
  return events
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
