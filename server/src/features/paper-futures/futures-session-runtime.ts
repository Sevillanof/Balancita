import { FuturesCommandRunner } from './futures-command-runner.ts'
import { canonicalHash } from './futures-canonical.ts'
import { FuturesStore } from './futures-store.ts'
import type { FuturesWorkerRequest } from './futures-worker.ts'
import { FuturesReplayDriver } from './futures-replay-driver.ts'
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

export class FuturesSessionRuntime {
  readonly store: FuturesStore
  readonly runner: FuturesCommandRunner
  runId: string
  private readonly drivers = new Map<string, Promise<FuturesReplayDriver>>()

  constructor(options: {
    dbPath: string
    mode: 'mock' | 'paper_live' | 'replay'
  }) {
    this.store = new FuturesStore(options.dbPath)
    const primaryRunId = 'futures-session:primary'
    this.store.createRun({
      runId: primaryRunId,
      config: {
        ledger_version: 'linear-usd-ledger.v1',
        decimal_precision: 50,
        leverage: '1',
        mode: options.mode,
        mode_config_hash: canonicalHash({ mode: options.mode, runtimeConfig }),
      },
      seed: {
        cash_usd: '10000',
        seed: 'mock-fixture-v1',
        source: options.mode,
      },
      instrument: { instrument_id: instrument.instrument_id },
      costs: {
        version: runtimeConfig.cost_version,
        maker: runtimeConfig.maker_rate,
        taker: runtimeConfig.taker_rate,
      },
      runtime: {
        schema_version: 'futures-runtime-binding.v4',
        runtime_config: runtimeConfig,
        instrument_spec: instrument,
        strategy_manifest: strategies,
        strategy_config_hash: canonicalHash(strategies),
      },
    })
    this.runId = this.store.getLatestRunId() ?? primaryRunId
    this.runner = new FuturesCommandRunner(this.store)
  }

  commandFactory = (command: TerminalPaperCommand): FuturesWorkerRequest => {
    const decisionTime =
      21_600_000 +
      Number(this.store.getRunProjection(command.run_id)!.state_version) * 100
    const action = command.action
    const control =
      action === 'paper.close' ||
      action === 'paper.pause' ||
      action === 'paper.resume'
        ? { type: action, command_id: command.command_id }
        : undefined
    return {
      request_id: command.command_id,
      run_id: command.run_id,
      work_id: command.command_id,
      expected_state_version: command.expected_state_version,
      payload: {
        operation: 'futures_runtime.v3',
        runtime_config: runtimeConfig,
        instrument,
        market_snapshot: createMockMarketSnapshot(
          decisionTime,
          action === 'paper.start',
          action === 'paper.start',
        ),
        ...(control ? { control } : {}),
      },
    }
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
        runtime_config: runtimeConfig,
        instrument,
        market_snapshot: createMockMarketSnapshot(21_600_000, false),
      },
    }
  }

  activateRun = (runId: string): void => {
    this.runId = runId
  }

  async start(): Promise<void> {
    await this.restoreDriver(this.runId)
    const pending = this.store.loadPendingCommands()
    if (pending.length > 0) {
      await this.runner.resumePending()
      this.drivers.delete(this.runId)
      await this.restoreDriver(this.runId)
    }
  }

  private restoreDriver(runId: string): Promise<FuturesReplayDriver> {
    const existing = this.drivers.get(runId)
    if (existing) return existing
    const manifest = this.replayManifest()
    const binding = {
      schema_version: 'futures-replay-session.v1',
      run_id: runId,
      manifest,
      instrument_hash: canonicalHash(instrument),
    }
    this.store.bindReplaySession(runId, binding)
    const replay = this.store.loadReplaySession(runId, binding)
    const restoring = FuturesReplayDriver.resumeSession({
      runId,
      manifest,
      durableStore: this.store,
      instrument,
      initialStateVersion:
        replay.works.length > 0
          ? 0
          : Number(this.store.getRunProjection(runId)?.state_version ?? 0),
      apply: async (work) => {
        const request = work.input.payload.request as FuturesWorkerRequest
        const accepted = this.runner.accept(
          request,
          work.input.payload.terminal_command as Parameters<
            FuturesCommandRunner['accept']
          >[1],
        )
        const result = await accepted.result
        return {
          status: 'committed',
          applied_state_version: Number(
            this.store.getRunProjection(request.run_id)?.state_version,
          ),
          economic_projection: result,
        }
      },
    })
    this.drivers.set(runId, restoring)
    return restoring
  }

  commandExecutor = (
    request: FuturesWorkerRequest,
    metadata: {
      readonly command_id: string
      readonly action: string
      readonly stream_run_id: string
      readonly expected_state_version: number
    },
  ) => {
    if (metadata.action === 'paper.new_run' || request.run_id.length === 0)
      return this.runner.accept(request, metadata)
    if (request.payload.operation !== 'futures_runtime.v3')
      throw new Error('Futures session runtime requires risk protocol v3.')
    const snapshot = request.payload.market_snapshot
    const driverResult = this.restoreDriver(request.run_id).then((driver) =>
      driver.processEvent({
        sequence: metadata.expected_state_version + 1,
        received_at_ms: Number(snapshot.decision_time_ms),
        event_time_ms: Number(snapshot.decision_time_ms),
        cycle_key: metadata.command_id,
        payload: {
          market_snapshot: snapshot,
          request,
          terminal_command: metadata,
        },
      }),
    )
    return {
      acknowledgement: {
        command_id: metadata.command_id,
        status: 'accepted',
      },
      result: driverResult.then(() => {
        const result = this.store.getCommandResult(metadata.command_id)
        if (!result)
          throw new Error('Replay driver completed without a worker result.')
        return result
      }),
    }
  }

  private replayManifest() {
    return {
      schema_version: 'futures-replay-manifest.v1',
      source: 'versioned-mock-fixture.v1',
      source_hash: canonicalHash(
        createMockMarketSnapshot(21_600_000, true, true),
      ),
      config_hash: canonicalHash(runtimeConfig),
      seed: 'mock-fixture-v1',
      fidelity: 'closed-ohlc-book-ticker-known-zero-funding.v1',
      runtime_version: runtimeConfig.version,
      instrument_hash: canonicalHash(instrument),
    } as const
  }

  async close(): Promise<void> {
    await this.runner.close()
    this.store.close()
  }
}

export function createMockMarketSnapshot(
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
