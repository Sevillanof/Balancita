import {
  FuturesCommandRunner,
  type FuturesAdmissionState,
} from './futures-command-runner.ts'
import type { FuturesSqlObserver } from './futures-store.ts'
import type { FuturesWorkerDiagnostic } from './futures-worker.ts'
import { canonicalHash } from './futures-canonical.ts'
import { FuturesStore } from './futures-store.ts'
import type { FuturesWorkerRequest } from './futures-worker.ts'
import { randomUUID } from 'node:crypto'
import type { TerminalPaperCommand } from '../terminal-stream/terminal-stream.ts'

const instrument = {
  instrument_id: 'kraken-futures:PF_XBTUSD',
  provider_symbol: 'PF_XBTUSD',
  quantity_step_btc: '0.0001',
  minimum_quantity_btc: '0.0001',
  price_tick_usd: '1',
} as const

const runtimeConfig = {
  version: 'futures-runtime-risk.v1',
  initial_cash_usd: '10000',
  max_notional_usd: '1000',
  max_exposure_multiple: '1',
  risk_fraction: '0.001',
  execution_latency_ms: 100,
  max_book_age_ms: 3000,
  max_spread_bps: '5',
  cost_version: 'kraken-futures-eea-btcusd-base.v1',
  maker_rate: '0.0002',
  taker_rate: '0.0005',
  daily_loss_fraction: '0.01',
} as const

const strategies = {
  config_version: 'futures-strategies-config.v1',
  indicator_version: 'futures-closed-indicators.v1',
  strategy_ids: [
    'c25-pullback-perp-v1',
    'c26-reversion-perp-v1',
    'c27-breakout-perp-v1',
    'c28-adapter-perp-v1',
  ],
} as const

const admissionPolicyBody = {
  schema_version: 'futures-entry-admission.v1',
  evaluation_interval_ms: 5000,
} as const
const admissionPolicy = {
  ...admissionPolicyBody,
  hash: canonicalHash(admissionPolicyBody),
} as const
const strategySelectionPolicy = {
  version: 'strategy-selection-cadence.v1',
  interval_ms: 5000,
} as const

/**
 * Kept for the protected futures-runtime.test.ts; no production caller. Live
 * and replay now run as separate processes (capture, gateway, verdicts C,
 * paper D); this class only builds the durable paper_live/mock bindings and
 * drives the due-work path that test exercises.
 */
export class FuturesSessionRuntime {
  readonly store: FuturesStore
  readonly runner: FuturesCommandRunner
  runId: string
  private readonly mode: 'mock' | 'paper_live'
  private runtimeConfig: typeof runtimeConfig & {
    funding_policy_version?: 'funding-separation.v1'
    strategy_selection_policy_version?: 'strategy-selection-cadence.v1'
    strategy_selection_interval_ms?: 5000
    market_context_policy_version?: 'market-context-transport.v1'
  }
  private readonly eventQueues = new Map<string, Promise<unknown>>()
  private closed = false

  constructor(options: {
    dbPath: string
    mode: 'mock' | 'paper_live'
    observer?: FuturesSqlObserver
    workerObserver?: (event: FuturesWorkerDiagnostic) => void
  }) {
    this.mode = options.mode
    this.runtimeConfig =
      options.mode === 'paper_live'
        ? {
            ...runtimeConfig,
            funding_policy_version: 'funding-separation.v1',
            strategy_selection_policy_version: strategySelectionPolicy.version,
            strategy_selection_interval_ms: strategySelectionPolicy.interval_ms,
            market_context_policy_version: 'market-context-transport.v1',
          }
        : runtimeConfig
    this.store = new FuturesStore(options.dbPath)
    const primaryRunId = 'futures-session:primary'
    const existingBinding = this.store.getRuntimeBinding(primaryRunId)
    if (
      existingBinding &&
      typeof existingBinding.runtime_config === 'object' &&
      existingBinding.runtime_config !== null
    )
      this.runtimeConfig =
        existingBinding.runtime_config as typeof this.runtimeConfig
    this.store.createRun({
      runId: primaryRunId,
      config: {
        ledger_version: 'linear-usd-ledger.v1',
        decimal_precision: 50,
        leverage: '1',
        mode: options.mode,
        mode_config_hash: canonicalHash({
          mode: options.mode,
          runtimeConfig: this.runtimeConfig,
        }),
      },
      seed: {
        cash_usd: '10000',
        seed: 'mock-fixture-v1',
        source: options.mode,
        ...(options.mode === 'mock'
          ? { terminal_market: createTerminalMarketFixture() }
          : {}),
      },
      instrument: { instrument_id: instrument.instrument_id },
      costs: {
        version: this.runtimeConfig.cost_version,
        maker: this.runtimeConfig.maker_rate,
        taker: this.runtimeConfig.taker_rate,
      },
      runtime: {
        schema_version: 'futures-runtime-binding.v5',
        runtime_config: this.runtimeConfig,
        instrument_spec: instrument,
        strategy_manifest: strategies,
        strategy_config_hash: canonicalHash(strategies),
        admission_policy: admissionPolicy,
      },
    })
    this.runId = this.store.getLatestRunId() ?? primaryRunId
    this.runner = new FuturesCommandRunner(this.store, {
      observer: options.observer,
      workerObserver: options.workerObserver,
    })
  }

  newRunFactory = (
    command: TerminalPaperCommand,
    childRunId: string,
  ): FuturesWorkerRequest => {
    return {
      request_id: command.command_id,
      run_id: childRunId,
      work_id: command.command_id,
      expected_state_version: 0,
      payload: {
        operation: 'futures_runtime.v3',
        runtime_config: this.runtimeConfig,
        instrument,
        market_snapshot: this.initialMarketSnapshot(Date.now(), false),
      },
    }
  }

  private initialMarketSnapshot(time: number, breakout: boolean) {
    if (this.mode === 'mock')
      return createMockMarketSnapshot(time, breakout, breakout)
    return {
      mode: this.mode,
      instrument,
      decision_time_ms: time,
      cutoff_received_at_ms: time,
      events: [],
    }
  }

  getAdmissionState(sourceClock: number): FuturesAdmissionState {
    return this.runner.readAdmissionState(
      this.runId,
      admissionPolicyBody,
      sourceClock,
    )
  }

  processDue(
    decisionClock: number,
  ): Promise<{ status: 'processed' | 'not_due' | 'unavailable' }> {
    if (this.closed) return Promise.resolve({ status: 'unavailable' })
    const runId = this.runId
    return this.enqueueEvent(runId, async () => {
      if (this.closed || this.runId !== runId)
        return { status: 'unavailable' as const }
      const admission = this.getAdmissionState(decisionClock)
      if (
        admission.source_clock_ms !== decisionClock ||
        admission.confirmed_state_version === null ||
        admission.next_due_at.time_ms === null ||
        admission.next_due_at.time_ms > decisionClock ||
        (admission.next_due_at.unknown_reasons.length > 0 &&
          !(
            admission.next_due_at.unknown_reasons.every(
              (reason) => reason === 'funding_boundary_unknown',
            ) &&
            (admission.outstanding_risk.reduction_intent_id !== null ||
              admission.outstanding_risk.position === true)
          )) ||
        (admission.entry_block_causes?.some((cause) =>
          ['funding_unavailable', 'funding_accounting_incomplete'].includes(
            cause,
          ),
        ) &&
          admission.next_due_at.reasons.includes('strategy_evaluation') &&
          admission.outstanding_risk.reduction_intent_id === null &&
          admission.outstanding_risk.position !== true &&
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
        admission.pending_commands.known !== true ||
        admission.pending_commands.any !== false
      )
        return { status: 'not_due' as const }

      const requestId = randomUUID()
      const request: FuturesWorkerRequest = {
        request_id: requestId,
        run_id: runId,
        work_id: requestId,
        expected_state_version: admission.confirmed_state_version,
        payload: {
          operation: 'futures_runtime.v3',
          runtime_config: this.runtimeConfig,
          instrument,
          market_snapshot: this.initialMarketSnapshot(decisionClock, false),
        },
      }
      const accepted = this.runner.acceptDue(
        request,
        admissionPolicyBody,
        decisionClock,
      )
      await accepted.result
      return { status: 'processed' as const }
    })
  }

  commandExecutor = (
    request: FuturesWorkerRequest,
    metadata: {
      readonly command_id: string
      readonly action: string
      readonly stream_run_id: string
      readonly expected_state_version: number
      readonly child_run_id?: string
    },
  ) => {
    if (this.closed) throw new Error('Futures session runtime is closed.')
    if (metadata.action !== 'paper.new_run')
      throw new Error('Futures session runtime only accepts paper.new_run.')
    return this.runner.accept(request, metadata)
  }

  private enqueueEvent<T>(
    runId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.eventQueues.get(runId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    this.eventQueues.set(runId, current)
    const clear = () => {
      if (this.eventQueues.get(runId) === current)
        this.eventQueues.delete(runId)
    }
    void current.then(clear, clear)
    return current
  }

  async close(): Promise<void> {
    this.closed = true
    await Promise.allSettled([...this.eventQueues.values()])
    await this.runner.close()
    this.store.close()
  }
}

function createMockMarketSnapshot(
  time: number,
  breakout: boolean,
  includeKnownFunding = false,
): Record<string, unknown> {
  const events: Record<string, unknown>[] = []
  const candleCutoff = Math.floor(time / 60_000) * 60_000
  let order = 0
  for (const interval of [60_000, 300_000]) {
    for (let index = 0; index < 60; index += 1) {
      order += 1
      const close =
        breakout && interval === 60_000 && index === 59 ? '100100' : '100000'
      events.push({
        type: 'candle',
        interval_ms: interval,
        bucket_start_ms: candleCutoff - (60 - index) * interval,
        event_time_ms: candleCutoff - (59 - index) * interval,
        received_at_ms: candleCutoff - (59 - index) * interval,
        known_at_ms: candleCutoff - (59 - index) * interval,
        reception_order: order,
        closed: true,
        coverage: 'complete',
        open: '100000',
        high:
          breakout && interval === 60_000 && index === 59 ? '100101' : '100050',
        low: '99950',
        close,
        volume_btc: breakout && interval === 60_000 && index === 59 ? '2' : '1',
      })
    }
  }
  events.push(
    {
      type: 'book_snapshot',
      event_time_ms: time,
      received_at_ms: time,
      known_at_ms: time,
      reception_order: ++order,
      epoch: 'mock-v1',
      sequence: Math.floor(time / 100),
      contiguous: true,
      valid: true,
      bids: [{ price_usd: '100000', quantity_btc: '1' }],
      asks: [{ price_usd: '100001', quantity_btc: '1' }],
    },
    {
      type: 'ticker',
      event_time_ms: time,
      received_at_ms: time,
      known_at_ms: time,
      reception_order: ++order,
      mark_usd: '100000.5',
      market_status: 'open',
    },
    ...(includeKnownFunding
      ? [
          {
            type: 'funding_observation',
            event_time_ms: time,
            received_at_ms: time,
            known_at_ms: time,
            reception_order: ++order,
            observation: {
              source: 'versioned-mock-fixture.v1',
              provider: 'kraken',
              product: 'PF_XBTUSD',
              field: 'funding_rate',
              raw_rate: '0',
              unit: 'usd_per_btc_per_hour',
              effective_start_ms: Math.floor(time / 3_600_000) * 3_600_000,
              effective_end_ms:
                Math.floor(time / 3_600_000) * 3_600_000 + 3_600_000,
              known_at_ms: time,
              received_seq: order,
              observation_id: `mock-funding-${time}`,
              sha256: '0'.repeat(64),
              semantic_version: 'kraken-funding-normalization.v1',
              predicted: false,
            },
          },
        ]
      : []),
  )
  return {
    mode: 'mock',
    instrument,
    decision_time_ms: time,
    cutoff_received_at_ms: time,
    events,
  }
}

function createTerminalMarketFixture(): Record<string, unknown> {
  const snapshot = createMockMarketSnapshot(21_600_000, false, true)
  const events = snapshot.events as Record<string, unknown>[]
  const candles = events
    .filter(
      (event) =>
        event.type === 'candle' &&
        event.interval_ms === 60_000 &&
        event.closed === true,
    )
    .map((event) => ({
      time_ms: event.bucket_start_ms,
      open: event.open,
      high: event.high,
      low: event.low,
      close: event.close,
      volume_btc: event.volume_btc,
      closed: true,
    }))
  return {
    schema_version: 'mock-terminal-market.v1',
    as_of_ms: snapshot.decision_time_ms,
    interval_ms: 60_000,
    candles,
  }
}
