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
    if (request.checkpoint !== undefined)
      throw new Error(
        'Futures command checkpoint is assigned by the Node store.',
      )
    validateFuturesWorkerRequest(request)
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
      const runtimeConfig = this.store.getRuntimeBinding(runId)?.runtime_config
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
      if (checkpoint.ledger_position !== null)
        unknownReasons.push('funding_boundary_unknown')
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

  private async commit(
    result: FuturesWorkerResult,
    request: FuturesWorkerRequest,
  ): Promise<FuturesWorkerCommit> {
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
