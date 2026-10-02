import { isDeepStrictEqual } from 'node:util'
import { FuturesStore } from './futures-store.ts'
import {
  FuturesWorker,
  type FuturesWorkerCommit,
  type FuturesWorkerRequest,
  type FuturesWorkerResult,
  validateFuturesWorkerRequest,
} from './futures-worker.ts'

const INSTRUMENT_ID = 'kraken-futures:PF_XBTUSD'
const COST_VERSION = 'kraken-futures-eea-btcusd-base.v1'

/** Accepts commands durably before scheduling their deterministic ledger fixture. */
export class FuturesCommandRunner {
  private readonly worker: FuturesWorker
  private readonly inFlight = new Map<
    string,
    Promise<Record<string, unknown>>
  >()
  private readonly store: FuturesStore

  constructor(store: FuturesStore) {
    this.store = store
    this.worker = new FuturesWorker({
      commitResult: (result, request) => this.commit(result, request),
    })
  }

  accept(request: FuturesWorkerRequest): {
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
    if (request.payload.operation === 'futures_runtime.v1') {
      if (!binding)
        throw new Error(
          'C27 runtime request requires a frozen runtime binding.',
        )
      if (
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

  private async commit(
    result: FuturesWorkerResult,
    request: FuturesWorkerRequest,
  ): Promise<FuturesWorkerCommit> {
    if (
      result.operation === 'futures_runtime.v1' &&
      request.payload.operation === 'futures_runtime.v1' &&
      result.runtime_event_time_ms !==
        request.payload.market_snapshot.decision_time_ms
    )
      throw new Error(
        'Python C27 runtime decision time does not match accepted work.',
      )
    const snapshot = result.result
    const events = toStoreEvents(result)
    const envelope =
      result.operation === 'futures_runtime.v1'
        ? {
            schema_version: 'futures-runtime-work.v1',
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
    const receipt = this.store.applyResult(envelope)
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
    })
    this.inFlight.set(request.work_id, result)
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

function toStoreEvents(result: FuturesWorkerResult): Record<string, unknown>[] {
  if (result.operation === 'futures_runtime.v1')
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
  const position = output.position
  const events: Record<string, unknown>[] = [
    ...fills,
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
