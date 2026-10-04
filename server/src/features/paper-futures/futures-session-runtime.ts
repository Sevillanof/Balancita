import { FuturesCommandRunner } from './futures-command-runner.ts'
import type { FuturesSqlObserver } from './futures-store.ts'
import type { FuturesWorkerDiagnostic } from './futures-worker.ts'
import { canonicalHash } from './futures-canonical.ts'
import { FuturesStore } from './futures-store.ts'
import type { FuturesWorkerRequest } from './futures-worker.ts'
import {
  compareEconomicSemantics,
  FuturesReplayDriver,
} from './futures-replay-driver.ts'
import { randomUUID } from 'node:crypto'
import type { FuturesMarketStore } from '../kraken-futures/futures-market-store.ts'
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

function createReplayTerminalMarket(
  source: FuturesMarketStore,
  receivedCutoff: number,
) {
  const candles = (
    source.candlesAsOf(receivedCutoff) as Record<string, unknown>[]
  )
    .filter((candle) => Number(candle.interval_ms) === 60_000)
    .slice(-500)
    .map((candle) => ({
      time_ms: candle.bucket_start,
      open: candle.open_price,
      high: candle.high_price,
      low: candle.low_price,
      close: candle.close_price,
      volume_btc: candle.volume_btc,
      closed: true as const,
    }))
  const last = candles.at(-1)
  return {
    schema_version: 'futures-terminal-market.v1' as const,
    as_of_ms: last ? Number(last.time_ms) + 60_000 : 0,
    interval_ms: 60_000,
    candles,
  }
}

export class FuturesSessionRuntime {
  readonly store: FuturesStore
  readonly runner: FuturesCommandRunner
  runId: string
  private readonly mode: 'mock' | 'paper_live' | 'replay'
  private readonly replaySource?: FuturesMarketStore
  private readonly replaySourceHash?: string
  private readonly replaySourceFileHash?: string
  private readonly replaySourceMetadataHash?: string
  private readonly replaySourceQualityHash?: string
  private readonly replayCutoffMs?: number
  private readonly drivers = new Map<string, Promise<FuturesReplayDriver>>()
  private readonly eventQueues = new Map<string, Promise<unknown>>()
  private readonly mockTickTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >()

  constructor(options: {
    dbPath: string
    mode: 'mock' | 'paper_live' | 'replay'
    replaySource?: FuturesMarketStore
    replaySourceFileHash?: string
    replaySourceMetadataHash?: string
    replaySourceQualityHash?: string
    replayCutoffMs?: number
    observer?: FuturesSqlObserver
    workerObserver?: (event: FuturesWorkerDiagnostic) => void
  }) {
    this.mode = options.mode
    if (options.mode === 'replay' && options.replaySource === undefined)
      throw new Error('REPLAY requires a frozen futures market source.')
    this.replaySource = options.replaySource
    this.replaySourceFileHash = options.replaySourceFileHash
    this.replaySourceMetadataHash = options.replaySourceMetadataHash
    this.replaySourceQualityHash = options.replaySourceQualityHash
    this.replayCutoffMs = options.replayCutoffMs
    this.replaySourceHash = options.replaySource
      ? canonicalHash({
          events: options.replaySource.eventsAsOf(Number.MAX_SAFE_INTEGER),
          candles: options.replaySource.candlesAsOf(Number.MAX_SAFE_INTEGER),
          gaps: options.replaySource.gapsAsOf(Number.MAX_SAFE_INTEGER),
          ...(options.replaySource.fundingSourceEvidence().length === 0
            ? {}
            : { funding: options.replaySource.fundingSourceEvidence() }),
        })
      : undefined
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
        seed:
          options.mode === 'replay'
            ? `frozen-market:${this.replaySourceHash}`
            : 'mock-fixture-v1',
        source: options.mode,
        ...(options.mode === 'mock'
          ? { terminal_market: createTerminalMarketFixture() }
          : options.mode === 'replay' && options.replaySource
            ? {
                terminal_market: createReplayTerminalMarket(
                  options.replaySource,
                  options.replayCutoffMs ?? Number.MAX_SAFE_INTEGER,
                ),
              }
            : {}),
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
    this.runner = new FuturesCommandRunner(this.store, {
      observer: options.observer,
      workerObserver: options.workerObserver,
    })
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
        market_snapshot: this.initialMarketSnapshot(
          decisionTime,
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
        market_snapshot: this.initialMarketSnapshot(Date.now(), false),
      },
    }
  }

  activateRun = (runId: string): void => {
    this.runId = runId
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

  async start(): Promise<void> {
    await this.restoreDriver(this.runId)
    const pending = this.store.loadPendingCommands()
    if (pending.length > 0) {
      await this.runner.resumePending()
      this.drivers.delete(this.runId)
      await this.restoreDriver(this.runId)
    }
    if (this.mode === 'replay' && this.replaySource !== undefined) {
      const driver = await this.restoreDriver(this.runId)
      await driver.processMarketStore(
        this.replaySource,
        this.replayCutoffMs ?? Number.MAX_SAFE_INTEGER,
        instrument as unknown as Record<string, unknown>,
        undefined,
        'replay',
      )
    }
  }

  async processMarketEvidence(
    source: FuturesMarketStore,
    receivedAt: number,
  ): Promise<{ sourceWatermark: number }> {
    if (this.mode !== 'paper_live' && this.mode !== 'replay')
      throw new Error('Market evidence is not accepted in MOCK.')
    const driver = await this.restoreDriver(this.runId)
    return driver.processMarketStore(
      source,
      receivedAt,
      instrument as unknown as Record<string, unknown>,
      undefined,
      this.mode,
    )
  }

  async exportReplayRun() {
    if (this.mode !== 'replay' || this.replaySource === undefined)
      throw new Error('Verified run export is available only for REPLAY.')
    const activeDriver = await this.restoreDriver(this.runId)
    const activeExport = activeDriver.exportRun()
    const batchRunId = `${this.runId}:batch-verification:${randomUUID()}`
    const terminalMarket = createReplayTerminalMarket(
      this.replaySource,
      this.replayCutoffMs ?? Number.MAX_SAFE_INTEGER,
    )
    const frozen = {
      config: {
        ledger_version: 'linear-usd-ledger.v1',
        decimal_precision: 50,
        leverage: '1',
        mode: 'replay',
        mode_config_hash: canonicalHash({ mode: 'replay', runtimeConfig }),
      },
      seed: {
        cash_usd: '10000',
        seed: `frozen-market:${this.replaySourceHash}`,
        source: 'replay',
        terminal_market: terminalMarket,
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
    }
    this.store.createRun({ runId: batchRunId, ...frozen })
    const batchExport = await FuturesReplayDriver.replayMarketStore({
      runId: batchRunId,
      manifest: this.replayManifest(),
      store: this.replaySource,
      receivedCutoff: this.replayCutoffMs ?? Number.MAX_SAFE_INTEGER,
      instrument: instrument as unknown as Record<string, unknown>,
      mode: 'replay',
      durableStore: this.store,
      apply: async (work) => {
        const request: FuturesWorkerRequest = {
          request_id: work.analysis_id,
          run_id: batchRunId,
          work_id: work.work_id,
          expected_state_version: work.version,
          payload: {
            operation: 'futures_runtime.v3',
            runtime_config: runtimeConfig,
            instrument,
            market_snapshot: work.input.payload.market_snapshot as Record<
              string,
              unknown
            >,
          },
        }
        const result = await this.runner.accept(request).result
        return {
          status: 'committed',
          applied_state_version: Number(
            this.store.getRunProjection(batchRunId)?.state_version,
          ),
          economic_projection: result,
        }
      },
    })
    const comparison = compareEconomicSemantics(activeExport, batchExport)
    const verified =
      this.store.verifyRun(this.runId) &&
      this.store.verifyRun(batchRunId) &&
      comparison.equal &&
      activeExport.manifest.source_hash === this.replaySourceHash
    return {
      schema_version: 'futures-replay-export.v1',
      verified,
      run_id: this.runId,
      source_hash: this.replaySourceHash,
      source_file_hash: this.replaySourceFileHash,
      manifest_hash: activeExport.manifest_hash,
      semantic_hash: activeExport.semantic_hash,
      comparison,
      economic_export: activeExport,
      batch_verification: batchExport,
      ledger_export: this.store.exportRun(this.runId),
    }
  }

  private restoreDriver(runId: string): Promise<FuturesReplayDriver> {
    const existing = this.drivers.get(runId)
    if (existing) return existing
    const savedBinding = this.store.getReplaySessionBinding(runId)
    const savedManifest = savedBinding?.manifest
    const manifest =
      savedManifest && typeof savedManifest === 'object'
        ? (savedManifest as ReturnType<FuturesSessionRuntime['replayManifest']>)
        : this.replayManifest()
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
        const savedRequest = work.input.payload.request
        const request =
          savedRequest && typeof savedRequest === 'object'
            ? (savedRequest as FuturesWorkerRequest)
            : {
                request_id: work.analysis_id,
                run_id: runId,
                work_id: work.work_id,
                expected_state_version: work.version,
                payload: {
                  operation: 'futures_runtime.v3' as const,
                  runtime_config: runtimeConfig,
                  instrument,
                  market_snapshot: work.input.payload.market_snapshot as Record<
                    string,
                    unknown
                  >,
                },
              }
        const accepted = this.runner.accept(
          request,
          work.input.payload.terminal_command as
            Parameters<FuturesCommandRunner['accept']>[1] | undefined,
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
    const driverResult = this.enqueueEvent(request.run_id, async () => {
      const driver = await this.restoreDriver(request.run_id)
      return driver.processEvent({
        sequence: metadata.expected_state_version + 1,
        received_at_ms: Number(snapshot.decision_time_ms),
        event_time_ms: Number(snapshot.decision_time_ms),
        cycle_key: metadata.command_id,
        payload: {
          market_snapshot: snapshot,
          request,
          terminal_command: metadata,
        },
      })
    })
    if (
      this.mode === 'mock' &&
      (metadata.action === 'paper.start' || metadata.action === 'paper.close')
    )
      void driverResult.then(() => this.scheduleMockTick(request.run_id))
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

  private scheduleMockTick(runId: string): void {
    if (this.mockTickTimers.has(runId)) return
    const timer = setTimeout(() => {
      this.mockTickTimers.delete(runId)
      void this.enqueueEvent(runId, async () => {
        const projection = this.store.getRunProjection(runId)
        if (!projection) return
        const stateVersion = Number(projection.state_version)
        const time = 21_600_000 + (stateVersion + 1) * 100
        const snapshot = createMockMarketSnapshot(time, false, false)
        const events = snapshot.events as Record<string, unknown>[]
        const scheduledBook = events.find(
          (event) => event.type === 'book_snapshot',
        )
        if (!scheduledBook) return
        scheduledBook.epoch = 'mock-runtime-clock.v1'
        const request: FuturesWorkerRequest = {
          request_id: randomUUID(),
          run_id: runId,
          work_id: randomUUID(),
          expected_state_version: stateVersion,
          payload: {
            operation: 'futures_runtime.v3',
            runtime_config: runtimeConfig,
            instrument,
            market_snapshot: snapshot,
          },
        }
        const driver = await this.restoreDriver(runId)
        await driver.processEvent({
          sequence: stateVersion + 1,
          received_at_ms: time,
          event_time_ms: time,
          cycle_key: `mock-runtime-clock.v1:${stateVersion}`,
          payload: { market_snapshot: snapshot, request },
        })
      }).catch((error: unknown) => {
        console.error('Deterministic MOCK clock event failed.', error)
      })
    }, 100)
    this.mockTickTimers.set(runId, timer)
  }

  private replayManifest() {
    if (this.mode === 'replay')
      return {
        schema_version: 'futures-replay-manifest.v1',
        source: this.replaySource?.fundingSourceEvidence().length
          ? 'frozen-kraken-futures-market.v2'
          : 'frozen-kraken-futures-market.v1',
        source_hash: this.replaySourceHash!,
        config_hash: canonicalHash(runtimeConfig),
        seed: `frozen-market:${this.replaySourceHash}`,
        fidelity: this.replaySource?.fundingSourceEvidence().length
          ? 'persisted-public-events-known-candles-explicit-funding.v2'
          : 'persisted-public-futures-events-and-known-candles.v1',
        runtime_version: runtimeConfig.version,
        instrument_hash: canonicalHash(instrument),
        ...(this.replaySourceFileHash === undefined
          ? {}
          : { source_file_hash: this.replaySourceFileHash }),
        ...(this.replaySourceMetadataHash === undefined
          ? {}
          : { source_metadata_hash: this.replaySourceMetadataHash }),
        ...(this.replaySourceQualityHash === undefined
          ? {}
          : { source_quality_hash: this.replaySourceQualityHash }),
        ...(this.replayCutoffMs === undefined
          ? {}
          : { replay_cutoff_ms: this.replayCutoffMs }),
      } as const
    if (this.mode === 'paper_live')
      return {
        schema_version: 'futures-replay-manifest.v1',
        source: 'kraken-public-live-stream.v2',
        source_hash: canonicalHash({
          mode: this.mode,
          instrument,
          funding_source: 'kraken-historical-funding-rates.v1',
        }),
        config_hash: canonicalHash(runtimeConfig),
        seed: 'paper-live-session-v2',
        fidelity:
          'observed-public-trades-book-ticker-candles-explicit-funding.v2',
        runtime_version: runtimeConfig.version,
        instrument_hash: canonicalHash(instrument),
      } as const
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
    this.mockTickTimers.forEach(clearTimeout)
    this.mockTickTimers.clear()
    await Promise.allSettled([...this.eventQueues.values()])
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
