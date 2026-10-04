import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { FuturesCommandRunner } from './futures-command-runner.ts'
import { FuturesStore } from './futures-store.ts'
import { FuturesSessionRuntime } from './futures-session-runtime.ts'
import { canonicalHash } from './futures-canonical.ts'
import type { FuturesWorkerRequest } from './futures-worker.ts'
import {
  parseBookMessage,
  parseTickerMessage,
} from '../kraken-futures/futures-market.ts'

const instrument = {
  instrument_id: 'kraken-futures:PF_XBTUSD',
  provider_symbol: 'PF_XBTUSD',
  quantity_step_btc: '0.0001',
  minimum_quantity_btc: '0.0001',
  price_tick_usd: '1',
}

const runtimeConfig = {
  version: 'futures-runtime-lab.v1',
  initial_cash_usd: '10000',
  max_notional_usd: '1000',
  risk_fraction: '0.001',
  max_exposure_multiple: '1',
  max_spread_bps: '5',
  max_book_age_ms: 3000,
  execution_latency_ms: 0,
  maker_rate: '0.0002',
  taker_rate: '0.0005',
  cost_version: 'kraken-futures-eea-btcusd-base.v1',
}
type RuntimeRequest = Omit<FuturesWorkerRequest, 'payload'> & {
  payload: Extract<
    FuturesWorkerRequest['payload'],
    { operation: 'futures_runtime.v1' }
  >
}

describe('durable C27 futures runtime', () => {
  it('opts only new PAPER_LIVE session bindings into funding separation', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'futures-funding-binding-'))
    const live = new FuturesSessionRuntime({
      dbPath: join(directory, 'live.sqlite'),
      mode: 'paper_live',
    })
    const mock = new FuturesSessionRuntime({
      dbPath: join(directory, 'mock.sqlite'),
      mode: 'mock',
    })
    try {
      expect(
        (
          live.store.getRuntimeBinding(live.runId)!.runtime_config as Record<
            string,
            unknown
          >
        ).funding_policy_version,
      ).toBe('funding-separation.v1')
      expect(
        'funding_policy_version' in
          (mock.store.getRuntimeBinding(mock.runId)!.runtime_config as Record<
            string,
            unknown
          >),
      ).toBe(false)
    } finally {
      await live.close()
      await mock.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('fails admission closed while accepted runtime work is pending despite a cached flat checkpoint', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'futures-admission-snapshot-'))
    const path = join(directory, 'fixture.sqlite')
    const runId = 'admission-snapshot-run'
    const executionConfig = {
      ...runtimeConfig,
      version: 'futures-runtime-risk.v1',
      daily_loss_fraction: '0.01',
      execution_latency_ms: 100,
      funding_policy_version: 'funding-separation.v1',
    }
    const strategyManifest = {
      config_version: 'futures-strategies-config.v1',
      indicator_version: 'futures-closed-indicators.v1',
      strategy_ids: [
        'c25-pullback-perp-v1',
        'c26-reversion-perp-v1',
        'c27-breakout-perp-v1',
        'c28-adapter-perp-v1',
      ],
    }
    const store = new FuturesStore(path)
    store.createRun({
      runId,
      config: {
        ledger_version: 'linear-usd-ledger.v1',
        decimal_precision: 50,
        leverage: '1',
      },
      seed: { cash_usd: '10000' },
      instrument: { instrument_id: instrument.instrument_id },
      costs: {
        version: runtimeConfig.cost_version,
        maker: runtimeConfig.maker_rate,
        taker: runtimeConfig.taker_rate,
      },
      runtime: {
        schema_version: 'futures-runtime-binding.v5',
        runtime_config: executionConfig,
        instrument_spec: instrument,
        strategy_manifest: strategyManifest,
        strategy_config_hash: canonicalHash(strategyManifest),
        admission_policy: {
          schema_version: 'futures-entry-admission.v1',
          evaluation_interval_ms: 5000,
          hash: canonicalHash({
            schema_version: 'futures-entry-admission.v1',
            evaluation_interval_ms: 5000,
          }),
        },
      },
    })
    const runner = new FuturesCommandRunner(store)
    const request = (
      workId: string,
      version: number,
      snapshot: Record<string, unknown>,
    ): FuturesWorkerRequest => ({
      request_id: `request-${workId}`,
      run_id: runId,
      work_id: workId,
      expected_state_version: version,
      payload: {
        operation: 'futures_runtime.v3',
        runtime_config: executionConfig,
        instrument,
        market_snapshot: snapshot,
      },
    })
    const policy = {
      schema_version: 'futures-entry-admission.v1',
      evaluation_interval_ms: 5000,
    } as const
    try {
      const unknownFundingMarket = market(21_600_000, 'flat', '100000', false)
      unknownFundingMarket.mode = 'paper_live'
      await runner.accept(request('admission-flat', 0, unknownFundingMarket))
        .result
      const flat = runner.readAdmissionState(runId, policy, 21_600_001)
      expect(flat.ledger_position).toEqual({ known: true, value: null })
      expect(flat.may_omit_entry_evaluation).toBe(true)
      expect(flat.execution_required).toBe(false)
      expect(flat.entry_block_causes).toContain('funding_unavailable')
      expect(flat.financial_obligations).toEqual([])
      expect(store.getRunProjection(runId)?.result).toMatchObject({
        funding_complete: true,
        quantity_btc: '0',
      })
      const originalGetProjection = store.getRunProjection.bind(store)
      for (const guardCase of [
        { name: 'daily_loss_latched', flag: 'daily_loss_latched' },
        { name: 'unclassified system pause', flag: 'system_paused' },
      ]) {
        const projection = originalGetProjection(runId)!
        const checkpoint = structuredClone(
          projection.checkpoint as Record<string, unknown>,
        )
        const risk = checkpoint.risk_checkpoint as Record<string, unknown>
        const funding = checkpoint.funding_policy_checkpoint as Record<
          string,
          unknown
        >
        risk[guardCase.flag] = true
        risk.entry_paused = true
        funding.entry_block_causes = [
          'funding_unavailable',
          ...(guardCase.flag === 'daily_loss_latched'
            ? ['daily_loss_latched']
            : ['unclassified_restored_pause']),
        ]
        vi.spyOn(store, 'getRunProjection').mockReturnValue({
          ...projection,
          checkpoint,
        })
        const guardRunner = new FuturesCommandRunner(store)
        try {
          const guarded = guardRunner.readAdmissionState(
            runId,
            policy,
            21_600_001,
          )
          expect(guarded.execution_required, guardCase.name).toBe(true)
          expect(guarded.may_omit_entry_evaluation, guardCase.name).toBe(false)
          expect(guarded.entry_block_causes).toContain(
            guardCase.flag === 'daily_loss_latched'
              ? 'daily_loss_latched'
              : 'unclassified_restored_pause',
          )
        } finally {
          await guardRunner.close()
          vi.restoreAllMocks()
        }
      }
      expect(
        (
          (
            store.getRunProjection(runId)?.runtime_output as Record<
              string,
              unknown
            >
          ).risk as Record<string, unknown>
        ).entry_paused,
      ).toBe(true)
      expect(
        (
          (
            store.getRunProjection(runId)?.runtime_output as Record<
              string,
              unknown
            >
          ).funding_policy as Record<string, unknown>
        ).availability,
      ).toBe('unknown')
      expect(
        runner.readAdmissionState(runId, policy, 21_600_002).source_clock_ms,
      ).toBe(21_600_002)

      const knownFundingMarket = withKnownFunding(market(21_600_002, 'long'))
      knownFundingMarket.mode = 'paper_live'
      const accepted = runner.accept(
        request('admission-order', 1, knownFundingMarket),
      )
      const beforeCommit = runner.readAdmissionState(runId, policy, 21_600_002)
      expect(beforeCommit.execution_required).toBe(true)
      expect(beforeCommit.may_omit_entry_evaluation).toBe(false)
      await accepted.result
      expect(
        (
          store.getRunProjection(runId)?.runtime_output as Record<
            string,
            unknown
          >
        ).funding_policy,
      ).toMatchObject({
        availability: 'known',
        entry_block_causes: [],
      })

      const activeOrder = runner.readAdmissionState(runId, policy, 21_600_003)
      expect(activeOrder.active_order_count).toBe(1)
      expect(activeOrder.execution_required).toBe(true)
      expect(activeOrder.may_omit_entry_evaluation).toBe(false)
      expect(activeOrder.next_due_at).toMatchObject({
        time_ms: 21_600_102,
        reasons: ['order_eligibility'],
      })
      const unservedEligibility = runner.readAdmissionState(
        runId,
        policy,
        21_600_103,
      )
      expect(unservedEligibility.execution_required).toBe(true)
      expect(unservedEligibility.next_due_at).toMatchObject({
        time_ms: 21_600_102,
        reasons: ['order_eligibility'],
      })

      const partialMarket = withKnownFunding(market(21_600_102, 'long'))
      const partialBook = (
        partialMarket.events as Record<string, unknown>[]
      ).find((event) => event.type === 'book_snapshot')!
      ;(partialBook.asks as { quantity_btc: string }[])[0]!.quantity_btc =
        '0.005'
      await runner.accept(request('admission-partial-fill', 2, partialMarket))
        .result
      expect(store.getRunProjection(runId)?.result).toMatchObject({
        quantity_btc: '0.005',
      })
      expect(
        (store.exportRun(runId).events as Record<string, unknown>[]).filter(
          (event) => event.type === 'fill',
        ),
      ).toHaveLength(1)
      const checkpoint = store.getRunProjection(runId)?.checkpoint as Record<
        string,
        unknown
      >
      const partialExecution = checkpoint.execution_checkpoint as Record<
        string,
        unknown
      >
      expect(
        Object.values(
          partialExecution.orders as Record<string, { state: string }>,
        ).map((order) => order.state),
      ).toContain('cancelled')
      const partialAdmission = runner.readAdmissionState(
        runId,
        policy,
        21_600_102,
      )
      expect(partialAdmission.execution_required).toBe(true)
      expect(partialAdmission.may_omit_entry_evaluation).toBe(false)
      expect(partialAdmission.next_due_at).toMatchObject({
        time_ms: 21_605_102,
        reasons: ['strategy_evaluation'],
      })

      const protection = checkpoint.position_protection as Record<
        string,
        unknown
      >
      expect(typeof protection.stop).toBe('string')
      const stop = BigInt(protection.stop as string)
      const stopMarket = withKnownFunding(market(21_600_202, 'flat'))
      for (const event of stopMarket.events as Record<string, unknown>[]) {
        if (event.type === 'book_snapshot') {
          event.bids = [
            { price_usd: (stop - 1n).toString(), quantity_btc: '1' },
          ]
          event.asks = [{ price_usd: stop.toString(), quantity_btc: '1' }]
        } else if (event.type === 'ticker') {
          event.mark_usd = (stop - 1n).toString()
        }
      }
      await runner.accept(request('admission-stop-trigger', 3, stopMarket))
        .result
      const stopCheckpoint = store.getRunProjection(runId)
        ?.checkpoint as Record<string, unknown>
      const riskCheckpoint = stopCheckpoint.risk_checkpoint as Record<
        string,
        unknown
      >
      expect(typeof riskCheckpoint.reduction_intent_id).toBe('string')
      expect(
        runner.readAdmissionState(runId, policy, 21_600_202).execution_required,
      ).toBe(true)

      const closeMarket = withKnownFunding(market(21_600_302, 'flat'))
      for (const event of closeMarket.events as Record<string, unknown>[]) {
        if (event.type === 'book_snapshot') {
          event.bids = [
            { price_usd: (stop - 1n).toString(), quantity_btc: '1' },
          ]
          event.asks = [{ price_usd: stop.toString(), quantity_btc: '1' }]
        } else if (event.type === 'ticker') {
          event.mark_usd = (stop - 1n).toString()
        }
      }
      await runner.accept(request('admission-protection-fill', 4, closeMarket))
        .result
      expect(store.getRunProjection(runId)?.result).toMatchObject({
        quantity_btc: '0',
      })
      expect(
        (store.exportRun(runId).events as Record<string, unknown>[]).filter(
          (event) => event.type === 'fill',
        ),
      ).toHaveLength(2)
      expect(
        (store.getRunProjection(runId)?.result as Record<string, unknown>)
          .fees_usd,
      ).toBe('0.4998725')
      expect(
        runner.readAdmissionState(runId, policy, 21_600_302).execution_required,
      ).toBe(false)

      const pausedRequest = request(
        'admission-user-pause',
        5,
        withKnownFunding(market(21_600_402, 'flat')),
      )
      await runner.accept({
        ...pausedRequest,
        payload: {
          ...pausedRequest.payload,
          control: {
            type: 'paper.pause',
            command_id: 'admission-user-pause',
          },
        } as Extract<
          FuturesWorkerRequest['payload'],
          { operation: 'futures_runtime.v3' }
        >,
      }).result
      const pausedOutput = store.getRunProjection(runId)
        ?.runtime_output as Record<string, unknown>
      expect((pausedOutput.risk as Record<string, unknown>).user_paused).toBe(
        true,
      )
      expect(
        (pausedOutput.risk as Record<string, unknown>).entry_block_causes,
      ).toContain('user_paused')
      const userPausedAdmission = runner.readAdmissionState(
        runId,
        policy,
        21_600_402,
      )
      expect(userPausedAdmission.execution_required).toBe(true)
      expect(userPausedAdmission.may_omit_entry_evaluation).toBe(false)
    } finally {
      await runner.close().catch(() => undefined)
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.each([
    [100, 100],
    [101, 101],
    [1222, 2039],
  ])(
    'resumes a durable worker checkpoint with %i asks and %i bids',
    async (askCount, bidCount) => {
      const directory = mkdtempSync(join(tmpdir(), 'futures-depth-checkpoint-'))
      const path = join(directory, 'fixture.sqlite')
      const runId = 'depth-checkpoint-run'
      const executionConfig = {
        ...runtimeConfig,
        version: 'futures-runtime-execution.v1',
        execution_latency_ms: 100,
      }
      const store = new FuturesStore(path)
      store.createRun({
        runId,
        config: {
          ledger_version: 'linear-usd-ledger.v1',
          decimal_precision: 50,
          leverage: '1',
        },
        seed: { cash_usd: '10000' },
        instrument: { instrument_id: instrument.instrument_id },
        costs: {
          version: runtimeConfig.cost_version,
          maker: runtimeConfig.maker_rate,
          taker: runtimeConfig.taker_rate,
        },
        runtime: {
          schema_version: 'futures-runtime-binding.v3',
          runtime_config: executionConfig,
          instrument_spec: instrument,
        },
      })
      let runner = new FuturesCommandRunner(store)
      const makeRequest = (
        workId: string,
        expectedStateVersion: number,
        snapshot: Record<string, unknown>,
      ): FuturesWorkerRequest => ({
        request_id: `request-${workId}`,
        run_id: runId,
        work_id: workId,
        expected_state_version: expectedStateVersion,
        payload: {
          operation: 'futures_runtime.v2',
          runtime_config: executionConfig,
          instrument,
          market_snapshot: snapshot,
        },
      })
      try {
        const captured =
          askCount === 1222 && bidCount === 2039
            ? capturedPublicDepthFixture()
            : undefined
        const timestamp = captured?.decisionTimeMs ?? 21_600_000
        const firstMarket = market(timestamp, 'long', '84770')
        const book = (firstMarket.events as Record<string, unknown>[]).find(
          (event) => event.type === 'book_snapshot',
        )!
        book.asks =
          captured?.asks ??
          Array.from({ length: askCount }, (_, index) => ({
            price_usd: String(84771 + index * 2),
            quantity_btc: '0.0001',
          }))
        book.bids =
          captured?.bids ??
          Array.from({ length: bidCount }, (_, index) => ({
            price_usd: String(84770 - index * 2),
            quantity_btc: '0.0001',
          }))
        if (captured) {
          book.event_time_ms = captured.bookEventTimeMs
          book.received_at_ms = captured.bookReceivedAtMs
          book.known_at_ms = captured.bookReceivedAtMs
          book.epoch = captured.sequence
          book.sequence = captured.sequence
          const ticker = (firstMarket.events as Record<string, unknown>[]).find(
            (event) => event.type === 'ticker',
          )!
          ticker.event_time_ms = captured.tickerEventTimeMs
          ticker.received_at_ms = captured.tickerReceivedAtMs
          ticker.known_at_ms = captured.tickerReceivedAtMs
          ticker.mark_usd = captured.markUsd
        }
        await runner.accept(makeRequest('depth-open', 0, firstMarket)).result
        const saved = store.getRunProjection(runId)?.checkpoint as Record<
          string,
          unknown
        >
        const execution = saved.execution_checkpoint as Record<string, unknown>
        expect(execution.checkpoint_version).toBe(
          'paper-execution-checkpoint.v2',
        )
        const budgets = execution.book_budgets as [
          unknown,
          { asks: [string, string][]; bids: [string, string][] },
        ][]
        expect(budgets[0]![1].asks).toHaveLength(askCount)
        expect(budgets[0]![1].bids).toHaveLength(bidCount)

        const before = store.exportRun(runId)
        await runner.close()
        runner = new FuturesCommandRunner(store)
        const next = market(timestamp + 1, 'flat', '84770')
        await runner.accept(makeRequest('depth-next', 1, next)).result
        expect(store.getAppliedReceipt('depth-next')?.status).toBe('committed')
        expect(store.verifyRun(runId)).toBe(true)
        expect(
          (store.exportRun(runId).events as Record<string, unknown>[]).filter(
            (event) => event.type === 'fill',
          ),
        ).toEqual(
          (before.events as Record<string, unknown>[]).filter(
            (event) => event.type === 'fill',
          ),
        )
      } finally {
        await runner.close().catch(() => undefined)
        store.close()
        rmSync(directory, { recursive: true, force: true })
      }
    },
  )

  it('durably resumes a pending 100ms execution order, fills only on a later book, and closes through the real worker', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'futures-execution-runtime-'))
    const path = join(directory, 'fixture.sqlite')
    const runId = 'execution-runtime-run'
    const executionConfig = {
      ...runtimeConfig,
      version: 'futures-runtime-execution.v1',
      execution_latency_ms: 100,
    }
    const storeFor = () => {
      const value = new FuturesStore(path)
      value.createRun({
        runId,
        config: {
          ledger_version: 'linear-usd-ledger.v1',
          decimal_precision: 50,
          leverage: '1',
        },
        seed: { cash_usd: '10000' },
        instrument: { instrument_id: instrument.instrument_id },
        costs: {
          version: runtimeConfig.cost_version,
          maker: runtimeConfig.maker_rate,
          taker: runtimeConfig.taker_rate,
        },
        runtime: {
          schema_version: 'futures-runtime-binding.v3',
          runtime_config: executionConfig,
          instrument_spec: instrument,
        },
      })
      return value
    }
    let store = storeFor()
    let runner = new FuturesCommandRunner(store)
    const makeExecutionRequest = (
      workId: string,
      version: number,
      snapshot: Record<string, unknown>,
      control?: Record<string, unknown>,
    ): FuturesWorkerRequest => ({
      request_id: `request-${workId}`,
      run_id: runId,
      work_id: workId,
      expected_state_version: version,
      payload: {
        operation: 'futures_runtime.v2',
        runtime_config: executionConfig,
        instrument,
        market_snapshot: snapshot,
        ...(control ? { control } : {}),
      },
    })
    try {
      const t0 = 21_600_000
      const initial = makeExecutionRequest(
        'execution-open',
        0,
        market(t0, 'long'),
      )
      const initialResult = await runner.accept(initial).result
      const openedPending = store.getRunProjection(runId) as {
        result: { quantity_btc: string; fees_usd: string }
        checkpoint: Record<string, unknown> & {
          execution_checkpoint: Record<string, unknown>
        }
      }
      expect(openedPending.result.quantity_btc).toBe('0')
      expect(openedPending.checkpoint.schema_version).toBe(3)
      const executionCheckpoint = openedPending.checkpoint.execution_checkpoint
      const pendingOrders = executionCheckpoint.orders as Record<
        string,
        { eligible_at_ms: number }
      >
      const originalOrderId = Object.keys(pendingOrders)[0]!
      expect(pendingOrders[originalOrderId]!.eligible_at_ms).toBe(t0 + 100)
      expect(store.verifyRun(runId)).toBe(true)
      expect(await runner.accept(initial).result).toEqual(initialResult)
      expect(store.exportRun(runId).events).toHaveLength(3)
      await runner.close()
      store.close()

      store = storeFor()
      runner = new FuturesCommandRunner(store)
      const beforeEligible = market(t0 + 99, 'flat')
      beforeEligible.events = (
        market(t0, 'long').events as Record<string, unknown>[]
      ).map((event) =>
        event.type === 'book_snapshot' || event.type === 'ticker'
          ? { ...event, received_at_ms: t0 + 99, known_at_ms: t0 + 99 }
          : event,
      )
      beforeEligible.decision_time_ms = t0 + 99
      beforeEligible.cutoff_received_at_ms = t0 + 99
      const t99 = makeExecutionRequest('execution-t99', 1, beforeEligible)
      await runner.accept(t99).result
      expect(
        (store.getRunProjection(runId)?.result as Record<string, unknown>)
          .quantity_btc,
      ).toBe('0')
      const t99Checkpoint = (
        store.getRunProjection(runId)?.checkpoint as Record<string, unknown>
      ).execution_checkpoint as Record<string, unknown>
      expect(
        (t99Checkpoint.orders as Record<string, { eligible_at_ms: number }>)[
          originalOrderId
        ]!.eligible_at_ms,
      ).toBe(t0 + 100)

      const t100 = makeExecutionRequest(
        'execution-t100',
        2,
        market(t0 + 100, 'flat'),
      )
      const t100Result = await runner.accept(t100).result
      const t100Output = store.getRunProjection(runId)?.result as Record<
        string,
        unknown
      >
      expect(t100Output.quantity_btc).not.toBe('0')
      expect(t100Output.fees_usd).toBe('0.49500495')
      expect(store.verifyRun(runId)).toBe(true)
      const fillEvents = (
        store.exportRun(runId).events as Record<string, unknown>[]
      ).filter((event) => event.type === 'fill')
      expect(fillEvents).toHaveLength(1)
      expect(await runner.accept(t100).result).toEqual(t100Result)
      expect(
        (store.exportRun(runId).events as Record<string, unknown>[]).filter(
          (event) => event.type === 'fill',
        ),
      ).toHaveLength(1)

      const closeIntent = makeExecutionRequest(
        'execution-close-intent',
        3,
        market(t0 + 100, 'flat'),
        { type: 'paper.close', command_id: 'close-execution' },
      )
      await runner.accept(closeIntent).result
      await runner.close()
      store.close()
      store = storeFor()
      runner = new FuturesCommandRunner(store)
      const closeMarket = market(t0 + 200, 'flat')
      const closeBook = (closeMarket.events as Record<string, unknown>[]).find(
        (event) => event.type === 'book_snapshot',
      )!
      ;(closeBook.bids as Record<string, unknown>[])[0]!.quantity_btc = '0.001'
      const closeRequest = makeExecutionRequest(
        'execution-close-fill',
        4,
        closeMarket,
      )
      await runner.accept(closeRequest).result
      const partiallyClosed = store.getRunProjection(runId)?.result as Record<
        string,
        unknown
      >
      expect(partiallyClosed.quantity_btc).toBe('0.0089')
      expect(
        (store.getRunProjection(runId)?.checkpoint as Record<string, unknown>)
          .owner_strategy_id,
      ).toBe('c27-breakout-perp-v1')
      expect(store.verifyRun(runId)).toBe(true)

      const remainingCloseIntent = makeExecutionRequest(
        'execution-close-remainder-intent',
        5,
        market(t0 + 300, 'flat'),
        { type: 'paper.close', command_id: 'close-execution-remainder' },
      )
      await runner.accept(remainingCloseIntent).result
      const finalClose = makeExecutionRequest(
        'execution-close-remainder-fill',
        6,
        market(t0 + 400, 'flat'),
      )
      await runner.accept(finalClose).result
      expect(
        (store.getRunProjection(runId)?.result as Record<string, unknown>)
          .quantity_btc,
      ).toBe('0')
      expect(store.verifyRun(runId)).toBe(true)
      expect(
        store.getAppliedReceipt('execution-close-remainder-fill')?.status,
      ).toBe('committed')
    } finally {
      await runner.close().catch(() => undefined)
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('integrates the versioned four-strategy runtime through durable open, restart, owner hold and close', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'futures-strategies-'))
    const path = join(directory, 'fixture.sqlite')
    const runId = 'strategy-runtime-run'
    const strategyConfig = {
      ...runtimeConfig,
      version: 'futures-runtime-strategies.v1',
    }
    const strategyManifest = {
      config_version: 'futures-strategies-config.v1',
      indicator_version: 'futures-closed-indicators.v1',
      strategy_ids: [
        'c25-pullback-perp-v1',
        'c26-reversion-perp-v1',
        'c27-breakout-perp-v1',
        'c28-adapter-perp-v1',
      ],
    }
    const binding = {
      schema_version: 'futures-runtime-binding.v2',
      runtime_config: strategyConfig,
      instrument_spec: instrument,
      strategy_manifest: strategyManifest,
      strategy_config_hash: canonicalHash(strategyManifest),
    }
    const createStore = () => {
      const value = new FuturesStore(path)
      value.createRun({
        runId,
        config: {
          ledger_version: 'linear-usd-ledger.v1',
          decimal_precision: 50,
          leverage: '1',
        },
        seed: { cash_usd: '10000' },
        instrument: { instrument_id: instrument.instrument_id },
        costs: {
          version: runtimeConfig.cost_version,
          maker: runtimeConfig.maker_rate,
          taker: runtimeConfig.taker_rate,
        },
        runtime: binding,
      })
      return value
    }
    let store = createStore()
    let runner = new FuturesCommandRunner(store)
    try {
      const first = request(
        runId,
        'strategy-open',
        0,
        market(21_600_000, 'long'),
        undefined,
        strategyConfig,
      )
      const opened = await runner.accept(first).result
      expect(opened.type).toBe('command.result')
      let projection = store.getRunProjection(runId) as {
        result: { side: string; quantity_btc: string }
        checkpoint: Record<string, unknown>
      }
      expect(projection.result.side).toBe('long')
      expect(projection.checkpoint.runtime_version).toBe(
        'futures-strategy-baseline-perp-v1',
      )
      expect(projection.checkpoint.owner_strategy_id).toBe(
        'c27-breakout-perp-v1',
      )
      expect(projection.checkpoint.regime).toBe('range')
      const database = new DatabaseSync(path)
      const persisted = JSON.parse(
        (
          database
            .prepare(
              "SELECT payload_json FROM paper_futures_records WHERE work_id=? AND kind='applied-result'",
            )
            .get(first.work_id) as { payload_json: string }
        ).payload_json,
      ) as {
        runtime_output: {
          analysis: {
            proposals: {
              strategy_id: string
              delegated_strategy_id: string | null
            }[]
            selector: { action: string }
          }
        }
      }
      expect(
        persisted.runtime_output.analysis.proposals.map(
          (item) => item.strategy_id,
        ),
      ).toEqual([
        'c25-pullback-perp-v1',
        'c26-reversion-perp-v1',
        'c27-breakout-perp-v1',
        'c28-adapter-perp-v1',
      ])
      expect(persisted.runtime_output.analysis.selector.action).toBe('LONG')
      expect(
        persisted.runtime_output.analysis.proposals[3]?.delegated_strategy_id,
      ).toBe('c26-reversion-perp-v1')
      database.close()
      expect(await runner.accept(first).result).toEqual(opened)
      expect(
        (store.exportRun(runId).events as Record<string, unknown>[]).filter(
          (event) => event.type === 'fill',
        ),
      ).toHaveLength(1)
      expect(store.verifyRun(runId)).toBe(true)
      await runner.close()
      store.close()

      store = new FuturesStore(path)
      runner = new FuturesCommandRunner(store)
      const changedRegime = market(21_601_000, 'flat')
      const regimeBars = (
        changedRegime.events as Record<string, unknown>[]
      ).filter(
        (event) => event.type === 'candle' && event.interval_ms === 300_000,
      )
      regimeBars.forEach((bar, index) => {
        const close = 99_000 + index * 5
        bar.open = String(close - 10)
        bar.high = String(close + 50)
        bar.low = String(close - 50)
        bar.close = String(close)
      })
      const hysteresis = request(
        runId,
        'strategy-hysteresis',
        1,
        changedRegime,
        undefined,
        strategyConfig,
      )
      await runner.accept(hysteresis).result
      projection = store.getRunProjection(runId) as typeof projection
      expect(projection.result.quantity_btc).not.toBe('0')
      expect(projection.checkpoint.owner_strategy_id).toBe(
        'c27-breakout-perp-v1',
      )
      expect(projection.checkpoint.regime).toBe('range')

      const trending = market(21_602_000, 'flat')
      const trendingBars = (
        trending.events as Record<string, unknown>[]
      ).filter(
        (event) => event.type === 'candle' && event.interval_ms === 300_000,
      )
      trendingBars.forEach((bar, index) => {
        const close = 99_000 + index * 10
        bar.open = String(close - 10)
        bar.high = String(close + 50)
        bar.low = String(close - 50)
        bar.close = String(close)
      })
      const hold = request(
        runId,
        'strategy-hold',
        2,
        trending,
        undefined,
        strategyConfig,
      )
      await runner.accept(hold).result
      projection = store.getRunProjection(runId) as typeof projection
      expect(projection.checkpoint.owner_strategy_id).toBe(
        'c27-breakout-perp-v1',
      )
      expect(projection.checkpoint.regime).toBe('trend')
      expect(store.verifyRun(runId)).toBe(true)

      const close = request(
        runId,
        'strategy-close',
        3,
        market(21_660_000, 'flat', '100500'),
        { type: 'paper.close', command_id: 'close-strategy-owner' },
        strategyConfig,
      )
      await runner.accept(close).result
      projection = store.getRunProjection(runId) as typeof projection
      expect(projection.result.quantity_btc).toBe('0')
      expect(projection.checkpoint.owner_strategy_id).toBeNull()
      expect(store.verifyRun(runId)).toBe(true)
    } finally {
      await runner.close()
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('persists the daily-loss latch and queued protective reduction across a real worker restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'futures-risk-runtime-'))
    const path = join(directory, 'fixture.sqlite')
    const runId = 'risk-runtime-run'
    const riskConfig = {
      ...runtimeConfig,
      version: 'futures-runtime-risk.v1',
      execution_latency_ms: 100,
      daily_loss_fraction: '0.01',
    }
    const manifest = {
      config_version: 'futures-strategies-config.v1',
      indicator_version: 'futures-closed-indicators.v1',
      strategy_ids: [
        'c25-pullback-perp-v1',
        'c26-reversion-perp-v1',
        'c27-breakout-perp-v1',
        'c28-adapter-perp-v1',
      ],
    }
    const binding = {
      schema_version: 'futures-runtime-binding.v4',
      runtime_config: riskConfig,
      instrument_spec: instrument,
      strategy_manifest: manifest,
      strategy_config_hash: canonicalHash(manifest),
    }
    const createStore = () => {
      const value = new FuturesStore(path)
      value.createRun({
        runId,
        config: {
          ledger_version: 'linear-usd-ledger.v1',
          decimal_precision: 50,
          leverage: '1',
        },
        seed: { cash_usd: '10000' },
        instrument: { instrument_id: instrument.instrument_id },
        costs: {
          version: runtimeConfig.cost_version,
          maker: runtimeConfig.maker_rate,
          taker: runtimeConfig.taker_rate,
        },
        runtime: binding,
      })
      return value
    }
    const makeRiskRequest = (
      workId: string,
      expectedStateVersion: number,
      snapshot: Record<string, unknown>,
      control?: Record<string, unknown>,
    ): FuturesWorkerRequest => ({
      request_id: `request-${workId}`,
      run_id: runId,
      work_id: workId,
      expected_state_version: expectedStateVersion,
      payload: {
        operation: 'futures_runtime.v3',
        runtime_config: riskConfig,
        instrument,
        market_snapshot: snapshot,
        ...(control ? { control } : {}),
      },
    })
    let store = createStore()
    let runner = new FuturesCommandRunner(store)
    try {
      await runner.accept(
        makeRiskRequest('risk-open', 0, market(21_600_000, 'long')),
      ).result
      const entryMarket = market(21_600_100, 'flat')
      ;(entryMarket.events as Record<string, unknown>[]).find(
        (event) => event.type === 'book_snapshot',
      )!.asks = [{ price_usd: '100001', quantity_btc: '0.005' }]
      ;(entryMarket.events as Record<string, unknown>[]).push({
        type: 'funding',
        interval_id: 'observed-zero-risk-test',
        start_time_ms: 21_600_000,
        end_time_ms: 25_200_000,
        known_at_ms: 21_600_000,
        received_at_ms: 21_600_000,
        rate_usd_per_btc_hour: '0',
      })
      await runner.accept(makeRiskRequest('risk-entry-fill', 1, entryMarket))
        .result
      const opened = store.getRunProjection(runId) as {
        result: { quantity_btc: string; cash_usd: string }
        checkpoint: Record<string, unknown> & {
          risk_checkpoint: Record<string, unknown>
        }
      }
      expect(opened.result.quantity_btc).toBe('0.005')
      expect(opened.checkpoint.schema_version).toBe(4)
      expect(opened.checkpoint.risk_checkpoint.opening_equity_usd).toBe('10000')
      const entryOrders = opened.checkpoint.execution_checkpoint as {
        orders: Record<
          string,
          { state: string; remaining: string; filled: string }
        >
      }
      expect(Object.values(entryOrders.orders)).toEqual([
        expect.objectContaining({
          state: 'cancelled',
          remaining: '0.0049',
          filled: '0.005',
        }),
      ])

      const loss = market(21_600_200, 'flat', '70000')
      const pending = makeRiskRequest('risk-stop-gap', 2, loss, {
        type: 'paper.pause',
      })
      await runner.accept(pending).result
      let projection = store.getRunProjection(runId) as {
        result: {
          quantity_btc: string
          fees_usd: string
          funding_complete: boolean
          net_complete: string | null
          realized_net_complete: string | null
        }
        checkpoint: Record<string, unknown> & {
          risk_checkpoint: Record<string, unknown>
          execution_checkpoint: Record<string, unknown>
        }
        runtime_output: Record<string, unknown>
      }
      expect(projection.checkpoint.risk_checkpoint.daily_loss_latched).toBe(
        true,
      )
      expect(projection.checkpoint.risk_checkpoint.user_paused).toBe(true)
      expect(
        projection.checkpoint.risk_checkpoint.reduction_intent_id,
      ).toBeTruthy()
      const reductionId = String(
        projection.checkpoint.risk_checkpoint.reduction_intent_id,
      )
      const reductionOrder = (
        projection.checkpoint.execution_checkpoint.orders as Record<
          string,
          { eligible_at_ms: number; intent: { quantity_btc: string } }
        >
      )[reductionId]
      expect(reductionOrder.eligible_at_ms).toBe(21_600_300)
      expect(reductionOrder.intent.quantity_btc).toBe('0.005')
      expect(projection.result.quantity_btc).toBe('0.005')
      const latchHash = store.getAppliedReceipt('risk-stop-gap')?.result_hash
      expect(store.verifyRun(runId)).toBe(true)
      await runner.accept(pending).result
      expect(store.getAppliedReceipt('risk-stop-gap')?.result_hash).toBe(
        latchHash,
      )
      await runner.close()
      store.close()

      store = createStore()
      runner = new FuturesCommandRunner(store)
      const recoveredGap = market(21_600_300, 'flat', '87000')
      ;(recoveredGap.events as Record<string, unknown>[]).find(
        (event) => event.type === 'book_snapshot',
      )!.contiguous = false
      await runner.accept(
        makeRiskRequest('risk-gap-still-open', 3, recoveredGap),
      ).result
      projection = store.getRunProjection(runId) as typeof projection
      expect(projection.result.quantity_btc).toBe('0.005')
      expect(projection.checkpoint.risk_checkpoint.daily_loss_latched).toBe(
        true,
      )
      expect(
        (
          projection.checkpoint.execution_checkpoint.orders as Record<
            string,
            { eligible_at_ms: number }
          >
        )[reductionId]!.eligible_at_ms,
      ).toBe(21_600_300)
      await runner.close()
      store.close()

      store = createStore()
      runner = new FuturesCommandRunner(store)
      const recovered = market(21_600_400, 'flat', '87000')
      const result = await runner.accept(
        makeRiskRequest('risk-stop-fill', 4, recovered),
      ).result
      projection = store.getRunProjection(runId) as typeof projection
      expect(projection.result.quantity_btc).toBe('0')
      expect(projection.result.fees_usd).toBe('0.4675025')
      const fills = (
        store.exportRun(runId).events as Record<string, unknown>[]
      ).filter((event) => event.type === 'fill')
      expect(fills).toHaveLength(2)
      expect(fills[0]?.quantity_btc).toBe('0.005')
      expect(fills[1]?.quantity_btc).toBe('0.005')
      expect(fills[1]?.price_usd_per_btc).toBe('87000')
      const database = new DatabaseSync(path)
      const records = database
        .prepare(
          "SELECT work_id,payload_json FROM paper_futures_records WHERE run_id=? AND kind='applied-result' ORDER BY seq",
        )
        .all(runId) as { work_id: string; payload_json: string }[]
      const appliedRecords = records.map(
        (record) =>
          JSON.parse(record.payload_json) as {
            work_id: string
            runtime_output: {
              risk: Record<string, unknown>
              fills: Record<string, string>[]
              ledger: Record<string, string | boolean>
            }
          },
      )
      const openedRuntime = appliedRecords.find(
        (record) => record.work_id === 'risk-entry-fill',
      )!
      expect(openedRuntime.runtime_output.risk.estimated_close_complete).toBe(
        true,
      )
      expect(
        openedRuntime.runtime_output.risk.estimated_close_net_usd,
      ).toBeTypeOf('string')
      const gapRuntime = appliedRecords.find(
        (record) => record.work_id === 'risk-stop-gap',
      )!
      expect(gapRuntime.runtime_output.risk.estimated_close_net_usd).toBeTypeOf(
        'string',
      )
      expect(gapRuntime.runtime_output.risk.estimated_close_complete).toBe(true)
      const invalidBookRuntime = appliedRecords.find(
        (record) => record.work_id === 'risk-gap-still-open',
      )!
      expect(
        invalidBookRuntime.runtime_output.risk.estimated_close_net_usd,
      ).toBeNull()
      expect(
        invalidBookRuntime.runtime_output.risk.estimated_close_complete,
      ).toBe(false)
      const lossRuntime = appliedRecords.find(
        (record) => record.work_id === 'risk-stop-gap',
      )!
      expect(lossRuntime.runtime_output.ledger.unrealized_gross_usd).toBe(
        '-150.005',
      )
      expect(lossRuntime.runtime_output.ledger.fees_usd).toBe('0.2500025')
      expect(lossRuntime.runtime_output.ledger.funding_paid).toBe('0')
      expect(lossRuntime.runtime_output.ledger.equity_usd).toBe('9849.7449975')
      const runtimeFills = appliedRecords.flatMap((applied) => {
        return applied.runtime_output.fills
      })
      const reconciled = spawnSync(
        'python3',
        [
          '-c',
          "import json,sys; from decimal import Decimal; rows=json.loads(sys.argv[1]); gross=sum((Decimal(r['quantity_btc'])*(Decimal(r['price_usd_per_btc'])-Decimal('100001'))*(1 if r['action']=='sell' else -1) for r in rows),Decimal(0)); fees=sum((Decimal(r['fee_usd']) for r in rows),Decimal(0)); print(json.dumps({'gross':str(gross),'fees':str(fees),'equity':str(Decimal('10000')+gross-fees)}))",
          JSON.stringify(runtimeFills),
        ],
        { encoding: 'utf8' },
      )
      expect(reconciled.status).toBe(0)
      expect(JSON.parse(reconciled.stdout)).toEqual({
        gross: '-65.005',
        fees: '0.4675025',
        equity: '9934.5274975',
      })
      const finalRuntime = appliedRecords.find(
        (record) => record.work_id === 'risk-stop-fill',
      )!
      expect(finalRuntime.runtime_output.ledger.funding_paid).toBe('0')
      expect(finalRuntime.runtime_output.ledger.funding_complete).toBe(true)
      database.close()
      expect(store.verifyRun(runId)).toBe(true)
      const replay = await runner.accept(
        makeRiskRequest('risk-stop-fill', 4, recovered),
      ).result
      expect(replay).toEqual(result)
      expect(
        (store.exportRun(runId).events as Record<string, unknown>[]).filter(
          (event) => event.type === 'fill',
        ),
      ).toHaveLength(2)
      const denied = await runner.accept(
        makeRiskRequest('risk-entry-denied', 5, market(21_600_500, 'long'), {
          type: 'paper.resume',
        }),
      ).result
      expect(denied.type).toBe('command.result')
      projection = store.getRunProjection(runId) as typeof projection
      expect(projection.result.quantity_btc).toBe('0')
      expect(projection.checkpoint.risk_checkpoint.daily_loss_latched).toBe(
        true,
      )
      expect(projection.checkpoint.risk_checkpoint.user_paused).toBe(true)
      expect(projection.checkpoint.risk_checkpoint.entry_paused).toBe(true)
      const rollover = await runner.accept(
        makeRiskRequest('risk-utc-rollover', 6, market(86_400_000, 'long')),
      ).result
      expect(rollover.type).toBe('command.result')
      projection = store.getRunProjection(runId) as typeof projection
      expect(projection.checkpoint.risk_checkpoint.daily_loss_latched).toBe(
        false,
      )
      expect(projection.checkpoint.risk_checkpoint.utc_day).toBe('1970-01-02')
      expect(projection.checkpoint.risk_checkpoint.user_paused).toBe(true)
      expect(projection.checkpoint.risk_checkpoint.entry_paused).toBe(true)
      expect(store.verifyRun(runId)).toBe(true)

      await runner.accept(
        makeRiskRequest('risk-next-day-entry', 7, market(86_400_000, 'long'), {
          type: 'paper.resume',
        }),
      ).result
      await runner.accept(
        makeRiskRequest('risk-next-day-fill', 8, market(86_400_100, 'flat')),
      ).result
      const timeStopAt = 86_400_100 + 30 * 60_000
      const clockMarket = market(timeStopAt, 'flat')
      const oldBars = (
        market(86_400_000, 'flat').events as Record<string, unknown>[]
      ).filter((event) => event.type === 'candle')
      clockMarket.events = [
        ...(clockMarket.events as Record<string, unknown>[]).filter(
          (event) => event.type !== 'candle' && event.type !== 'funding',
        ),
        ...oldBars,
      ]
      await runner.accept(
        makeRiskRequest('risk-clock-stop', 9, clockMarket, {
          type: 'paper.pause',
        }),
      ).result
      projection = store.getRunProjection(runId) as typeof projection
      expect(projection.result.quantity_btc).toBe('0.0099')
      expect(projection.checkpoint.risk_checkpoint.user_paused).toBe(true)
      expect(projection.checkpoint.funding_complete).toBe(false)
      expect(projection.result.funding_complete).toBe(false)
      expect(projection.result.net_complete).toBeNull()
      expect(projection.result.realized_net_complete).toBeNull()
      expect(projection.checkpoint.risk_checkpoint.system_paused).toBe(true)
      const timeExitId = String(
        projection.checkpoint.risk_checkpoint.reduction_intent_id,
      )
      expect(
        (
          projection.checkpoint.execution_metadata as Record<
            string,
            { reason: string }
          >
        )[timeExitId]!.reason,
      ).toBe('time_stop')
      expect(
        (
          projection.checkpoint.execution_checkpoint.orders as Record<
            string,
            { eligible_at_ms: number }
          >
        )[timeExitId]!.eligible_at_ms,
      ).toBe(timeStopAt + 100)
      await runner.accept(
        makeRiskRequest(
          'risk-clock-stop-fill',
          10,
          market(timeStopAt + 100, 'flat', '87000'),
        ),
      ).result
      projection = store.getRunProjection(runId) as typeof projection
      expect(projection.result.quantity_btc).toBe('0')
      expect(projection.result.funding_complete).toBe(false)
      expect(projection.result.net_complete).toBeNull()
      expect(projection.result.realized_net_complete).toBeNull()
      expect(store.verifyRun(runId)).toBe(true)
    } finally {
      await runner.close().catch(() => undefined)
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('persists an open C27 position, replays another cycle, reopens and closes at the observed book', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'futures-runtime-'))
    const path = join(directory, 'fixture.sqlite')
    const runId = 'c27-runtime-run'
    const store = new FuturesStore(path)
    store.createRun({
      runId,
      config: {
        ledger_version: 'linear-usd-ledger.v1',
        decimal_precision: 50,
        leverage: '1',
      },
      seed: { cash_usd: '10000' },
      instrument: { instrument_id: instrument.instrument_id },
      costs: {
        version: 'kraken-futures-eea-btcusd-base.v1',
        maker: '0.0002',
        taker: '0.0005',
      },
      runtime: {
        schema_version: 'futures-runtime-binding.v1',
        runtime_config: runtimeConfig,
        instrument_spec: instrument,
      },
    })

    const first = request(runId, 'c27-open', 0, market(21_600_000, 'long'))
    const runner = new FuturesCommandRunner(store)
    try {
      const drifted = request(
        runId,
        'c27-config-drift',
        0,
        market(21_600_000, 'long'),
      )
      const driftedRequest: RuntimeRequest = {
        ...drifted,
        payload: {
          ...drifted.payload,
          runtime_config: { ...runtimeConfig, max_notional_usd: '900' },
        },
      }
      expect(() => runner.accept(driftedRequest)).toThrow(/frozen run binding/i)
      expect(store.loadPendingCommands()).toHaveLength(0)
      const roundTripRequest: FuturesWorkerRequest = {
        request_id: 'request-mixed-operation',
        run_id: runId,
        work_id: 'mixed-operation',
        expected_state_version: 0,
        payload: {
          operation: 'round_trip',
          cash_usd: '10000',
          side: 'long',
          quantity_btc: '0.01',
          entry_price: '100000',
          exit_price: '100001',
        },
      }
      expect(() => runner.accept(roundTripRequest)).toThrow(
        /operation does not match frozen run binding/i,
      )
      expect(store.loadPendingCommands()).toHaveLength(0)

      const accepted = runner.accept(first)
      expect(accepted.acknowledgement.status).toBe('accepted')
      const openResult = await accepted.result
      expect(openResult.type).toBe('command.result')
      expect(store.getAppliedReceipt(first.work_id)?.status).toBe('committed')
      expect(store.verifyRun(runId)).toBe(true)

      const opened = store.exportRun(runId)
      const runtimeRecord = new DatabaseSync(path)
      const committed = JSON.parse(
        (
          runtimeRecord
            .prepare(
              "SELECT payload_json FROM paper_futures_records WHERE work_id=? AND kind='applied-result'",
            )
            .get(first.work_id) as { payload_json: string }
        ).payload_json,
      ) as {
        runtime_output: { analysis: Record<string, unknown>; orders: unknown[] }
      }
      expect(committed.runtime_output.analysis.action).toBe('long')
      expect(committed.runtime_output.orders).toHaveLength(1)
      expect(
        (opened.events as Record<string, unknown>[]).map((event) => event.type),
      ).toEqual(expect.arrayContaining(['fill', 'position', 'account']))
      runtimeRecord.close()
      const projection = opened.projection as {
        result: { side: string; quantity_btc: string }
        checkpoint: {
          schema_version: number
          ledger_position: { side: string; qty: string } | null
          owner_strategy_id: string
        }
      }
      expect(projection.result.side).toBe('long')
      expect(projection.result.quantity_btc).not.toBe('0')
      expect(projection.checkpoint.schema_version).toBe(1)
      expect(projection.checkpoint.ledger_position?.side).toBe('long')
      expect(projection.checkpoint.owner_strategy_id).toContain('c27')
      const openedEvents = opened.events as Record<string, unknown>[]
      const eventCount = openedEvents.length
      const replay = await runner.accept(first).result
      expect(replay).toEqual(openResult)
      expect(store.exportRun(runId).events).toHaveLength(eventCount)
      expect(store.getRunProjection(runId)?.state_version).toBe(1)
      const conflicting = request(
        runId,
        first.work_id,
        0,
        market(21_600_000, 'flat'),
      )
      expect(() => runner.accept(conflicting)).toThrow(
        /conflicts with accepted payload/i,
      )
      expect(store.getRunProjection(runId)?.state_version).toBe(1)

      const second = request(
        runId,
        'c27-hold',
        1,
        market(21_601_000, 'flat', '100000'),
      )
      await runner.accept(second).result
      expect(store.verifyRun(runId)).toBe(true)
      await runner.close()
      store.close()

      const reopened = new FuturesStore(path)
      const restarted = new FuturesCommandRunner(reopened)
      try {
        const close = request(
          runId,
          'c27-close',
          2,
          market(21_660_000, 'flat', '100500'),
          { type: 'paper.close', command_id: 'close-c27' },
        )
        const closedResult = await restarted.accept(close).result
        expect(closedResult.type).toBe('command.result')
        const closed = reopened.exportRun(runId)
        const closedProjection = closed.projection as {
          result: {
            quantity_btc: string
            realized_net_complete: string | null
            funding_complete: boolean
          }
        }
        expect(reopened.verifyRun(runId)).toBe(true)
        expect(closedProjection.result.quantity_btc).toBe('0')
        expect(closedProjection.result.realized_net_complete).toBe('3.94762005')
        expect(closedProjection.result.funding_complete).toBe(true)
        expect(
          (closed.projection as { checkpoint: { ledger_position: unknown } })
            .checkpoint.ledger_position,
        ).toBeNull()
        expect(
          (closed.events as Record<string, unknown>[]).map(
            (event) => event.type,
          ),
        ).toContain('funding')
      } finally {
        await restarted.close()
        reopened.close()
      }
    } finally {
      if (store !== undefined) {
        try {
          await runner.close()
        } catch {
          // The process may not have started when request validation rejects.
        }
        try {
          store.close()
        } catch {
          // The store may already have been closed before the reopen check.
        }
      }
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('executes the C27 short branch through the same persistent worker and ledger', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'futures-runtime-short-'))
    const storePath = join(directory, 'fixture.sqlite')
    let store = new FuturesStore(storePath)
    const runId = 'c27-short-run'
    store.createRun({
      runId,
      config: {
        ledger_version: 'linear-usd-ledger.v1',
        decimal_precision: 50,
        leverage: '1',
      },
      seed: { cash_usd: '10000' },
      instrument: { instrument_id: instrument.instrument_id },
      costs: {
        version: runtimeConfig.cost_version,
        maker: runtimeConfig.maker_rate,
        taker: runtimeConfig.taker_rate,
      },
      runtime: {
        schema_version: 'futures-runtime-binding.v1',
        runtime_config: runtimeConfig,
        instrument_spec: instrument,
      },
    })
    let runner = new FuturesCommandRunner(store)
    try {
      const openingMarket = market(21_600_000, 'short', '100000', false)
      const openingEvents = openingMarket.events as Record<string, unknown>[]
      openingEvents.push(fundingObservation(21_600_000, 'short-rate'))
      const command = request(runId, 'c27-short-open', 0, openingMarket)
      const firstReceipt = await runner.accept(command).result
      const retryReceipt = await runner.accept(command).result
      expect(retryReceipt.result_hash).toBe(firstReceipt.result_hash)
      const projection = store.getRunProjection(runId) as {
        result: { side: string; quantity_btc: string }
        checkpoint: {
          ledger_position: { side: string; funding_cursor_ms: number }
          funding_paid: string
          owner_strategy_id: string
        }
      }
      expect(projection.result.side).toBe('short')
      expect(projection.result.quantity_btc).toBe('0.01')
      expect(projection.checkpoint.ledger_position.side).toBe('short')
      expect(projection.checkpoint.ledger_position.funding_cursor_ms).toBe(
        21_600_000,
      )
      expect(projection.checkpoint.funding_paid).toBe('0')
      expect(projection.checkpoint.owner_strategy_id).toBe(
        'c27-breakout-perp-v1',
      )
      const appliedDb = new DatabaseSync(storePath, { readOnly: true })
      const appliedRow = appliedDb
        .prepare(
          "SELECT payload_json FROM paper_futures_records WHERE work_id=? AND kind='applied-result'",
        )
        .get('c27-short-open') as { payload_json: string }
      const applied = JSON.parse(appliedRow.payload_json) as {
        runtime_output: { fills: Record<string, unknown>[] }
      }
      expect(applied.runtime_output.fills).toHaveLength(1)
      expect(applied.runtime_output.fills[0]?.event_time_ms).toBe(21_600_000)
      appliedDb.close()
      expect(store.verifyRun(runId)).toBe(true)
      await runner.close()
      store.close()
      store = new FuturesStore(storePath)
      runner = new FuturesCommandRunner(store)
      const closeMarket = market(21_660_000, 'flat', '100500', false)
      const closeEvents = closeMarket.events as Record<string, unknown>[]
      closeEvents.push(fundingObservation(21_600_000, 'short-rate'))
      const close = request(runId, 'c27-short-close', 1, closeMarket, {
        type: 'paper.close',
        command_id: 'close-short',
      })
      await runner.accept(close).result
      const closed = store.getRunProjection(runId) as {
        result: {
          side: string | null
          funding_complete: boolean
          net_complete: string | null
        }
        checkpoint: { ledger_position: unknown; funding_paid: string }
      }
      expect(closed.result.side).toBeNull()
      expect(closed.result.funding_complete).toBe(true)
      expect(closed.result.net_complete).toBe(
        '-6.0125050166666666666666666666666666666666666666667',
      )
      expect(closed.checkpoint.funding_paid).toBe(
        '0.000000016666666666666666666666666666666666666666666666667',
      )
      expect(closed.checkpoint.ledger_position).toBeNull()
      const closeDb = new DatabaseSync(storePath, { readOnly: true })
      const closeRow = closeDb
        .prepare(
          "SELECT payload_json FROM paper_futures_records WHERE work_id=? AND kind='applied-result'",
        )
        .get('c27-short-close') as { payload_json: string }
      const closeApplied = JSON.parse(closeRow.payload_json) as {
        runtime_output: { fills: Record<string, unknown>[] }
      }
      expect(closeApplied.runtime_output.fills).toHaveLength(1)
      expect(closeApplied.runtime_output.fills[0]?.event_time_ms).toBe(
        21_660_000,
      )
      closeDb.close()
      expect(store.verifyRun(runId)).toBe(true)
    } finally {
      await runner.close()
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('recovers the exact applied C27 receipt after the worker commit ACK is lost', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'futures-runtime-ack-loss-'))
    const path = join(directory, 'fixture.sqlite')
    const runId = 'c27-ack-loss-run'
    const store = new FuturesStore(path)
    store.createRun({
      runId,
      config: {
        ledger_version: 'linear-usd-ledger.v1',
        decimal_precision: 50,
        leverage: '1',
      },
      seed: { cash_usd: '10000' },
      instrument: { instrument_id: instrument.instrument_id },
      costs: {
        version: runtimeConfig.cost_version,
        maker: runtimeConfig.maker_rate,
        taker: runtimeConfig.taker_rate,
      },
      runtime: {
        schema_version: 'futures-runtime-binding.v1',
        runtime_config: runtimeConfig,
        instrument_spec: instrument,
      },
    })
    let loseAck = true
    const apply = store.applyResult.bind(store)
    store.applyResult = ((
      value: unknown,
      injectFailureAt?: 'before-commit',
    ) => {
      const receipt = apply(value, injectFailureAt)
      if (
        loseAck &&
        typeof value === 'object' &&
        value !== null &&
        'schema_version' in value
      ) {
        loseAck = false
        throw new Error('Injected post-commit ACK loss.')
      }
      return receipt
    }) as FuturesStore['applyResult']
    const runner = new FuturesCommandRunner(store)
    const command = request(
      runId,
      'c27-ack-lost',
      0,
      market(21_600_000, 'long'),
    )
    try {
      await expect(runner.accept(command).result).rejects.toThrow(
        'Injected post-commit ACK loss.',
      )
      expect(store.getAppliedReceipt(command.work_id)?.status).toBe('committed')
      await runner.close()
      store.close()

      const reopened = new FuturesStore(path)
      const restarted = new FuturesCommandRunner(reopened)
      try {
        const results = await restarted.resumePending()
        expect(results).toHaveLength(1)
        expect(reopened.getAppliedReceipt(command.work_id)?.status).toBe(
          'committed',
        )
        expect(
          (
            reopened.exportRun(runId).events as Record<string, unknown>[]
          ).filter((event) => event.type === 'fill'),
        ).toHaveLength(1)
        expect(reopened.verifyRun(runId)).toBe(true)
      } finally {
        await restarted.close()
        reopened.close()
      }
    } finally {
      try {
        await runner.close()
      } catch {
        /* Worker may have exited on the injected ACK loss. */
      }
      try {
        store.close()
      } catch {
        /* Store may already be closed before reopen. */
      }
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('rolls back a runtime result before commit and retries the accepted work once', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'futures-runtime-rollback-'))
    const path = join(directory, 'fixture.sqlite')
    const runId = 'c27-rollback-run'
    const store = new FuturesStore(path)
    store.createRun({
      runId,
      config: {
        ledger_version: 'linear-usd-ledger.v1',
        decimal_precision: 50,
        leverage: '1',
      },
      seed: { cash_usd: '10000' },
      instrument: { instrument_id: instrument.instrument_id },
      costs: {
        version: runtimeConfig.cost_version,
        maker: runtimeConfig.maker_rate,
        taker: runtimeConfig.taker_rate,
      },
      runtime: {
        schema_version: 'futures-runtime-binding.v1',
        runtime_config: runtimeConfig,
        instrument_spec: instrument,
      },
    })
    let failBeforeCommit = true
    const apply = store.applyResult.bind(store)
    store.applyResult = ((
      value: unknown,
      injectFailureAt?: 'before-commit',
    ) => {
      if (
        failBeforeCommit &&
        typeof value === 'object' &&
        value !== null &&
        'schema_version' in value
      ) {
        failBeforeCommit = false
        return apply(value, 'before-commit')
      }
      return apply(value, injectFailureAt)
    }) as FuturesStore['applyResult']
    const runner = new FuturesCommandRunner(store)
    const command = request(
      runId,
      'c27-rollback',
      0,
      market(21_600_000, 'long'),
    )
    try {
      await expect(runner.accept(command).result).rejects.toThrow(
        'Injected pre-commit failure.',
      )
      expect(store.getRunProjection(runId)?.state_version).toBe(0)
      expect(store.getAppliedReceipt(command.work_id)).toBeUndefined()
      expect(store.exportRun(runId).events).toHaveLength(0)
      await runner.close()
      store.close()

      const reopened = new FuturesStore(path)
      const restarted = new FuturesCommandRunner(reopened)
      try {
        await restarted.resumePending()
        expect(reopened.getRunProjection(runId)?.state_version).toBe(1)
        expect(
          (
            reopened.exportRun(runId).events as Record<string, unknown>[]
          ).filter((event) => event.type === 'fill'),
        ).toHaveLength(1)
        expect(reopened.verifyRun(runId)).toBe(true)
      } finally {
        await restarted.close()
        reopened.close()
      }
    } finally {
      try {
        await runner.close()
      } catch {
        /* Worker may have exited on the injected transaction failure. */
      }
      try {
        store.close()
      } catch {
        /* Store may already be closed before reopen. */
      }
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

function fundingObservation(startMs: number, observationId: string) {
  return {
    type: 'funding_observation',
    event_time_ms: startMs,
    received_at_ms: startMs,
    known_at_ms: startMs,
    reception_order: 10_000,
    observation: {
      source: 'deterministic-test-fixture',
      provider: 'kraken',
      product: 'PF_XBTUSD',
      field: 'funding_rate',
      raw_rate: '-0.0001',
      unit: 'usd_per_btc_per_hour',
      effective_start_ms: startMs,
      effective_end_ms: startMs + 3_600_000,
      known_at_ms: startMs,
      received_seq: 1,
      observation_id: observationId,
      sha256: 'a'.repeat(64),
      semantic_version: 'kraken-funding-normalization.v1',
      predicted: false,
    },
  }
}

function request(
  runId: string,
  workId: string,
  expectedStateVersion: number,
  snapshot: Record<string, unknown>,
  control?: Record<string, unknown>,
  config: Record<string, unknown> = runtimeConfig,
): RuntimeRequest {
  return {
    request_id: `request-${workId}`,
    run_id: runId,
    work_id: workId,
    expected_state_version: expectedStateVersion,
    payload: {
      operation: 'futures_runtime.v1',
      runtime_config: config,
      instrument,
      market_snapshot: snapshot,
      ...(control ? { control } : {}),
    },
  }
}

function market(
  cutoffMs: number,
  breakout: 'long' | 'short' | 'flat',
  basePrice = '100000',
  includeFunding = true,
): Record<string, unknown> {
  const events: Record<string, unknown>[] = []
  let receptionOrder = 0
  for (const [intervalMs, count] of [
    [60_000, 60],
    [300_000, 60],
  ] as const) {
    for (let index = 0; index < count; index += 1) {
      receptionOrder += 1
      const base = BigInt(basePrice)
      const direction =
        breakout !== 'flat' && intervalMs === 60_000 && index === count - 1
      const close = direction
        ? base + (breakout === 'long' ? 100n : -100n)
        : base
      const high = direction
        ? breakout === 'long'
          ? close + 1n
          : base + 1n
        : base + 50n
      const low = direction
        ? breakout === 'short'
          ? close - 1n
          : base - 1n
        : base - 50n
      const bucketStart = cutoffMs - (count - index) * intervalMs
      const knownAt = bucketStart + intervalMs
      events.push({
        type: 'candle',
        interval_ms: intervalMs,
        bucket_start_ms: bucketStart,
        event_time_ms: knownAt,
        received_at_ms: knownAt,
        known_at_ms: knownAt,
        reception_order: receptionOrder,
        closed: true,
        coverage: 'complete',
        open: basePrice,
        high: high.toString(),
        low: low.toString(),
        close: close.toString(),
        volume_btc: direction ? '2' : '1',
      })
    }
  }
  const fundingStart = Math.floor(cutoffMs / 3_600_000) * 3_600_000
  if (includeFunding)
    events.push({
      type: 'funding',
      interval_id: `utc-hour-${fundingStart}`,
      start_time_ms: fundingStart,
      end_time_ms: fundingStart + 3_600_000,
      rate_usd_per_btc_hour: '0',
      event_time_ms: fundingStart,
      received_at_ms: fundingStart,
      known_at_ms: fundingStart,
      reception_order: receptionOrder + 1,
    })
  events.push(
    {
      type: 'book_snapshot',
      event_time_ms: cutoffMs,
      received_at_ms: cutoffMs,
      known_at_ms: cutoffMs,
      reception_order: receptionOrder + 2,
      epoch: 1,
      sequence: cutoffMs,
      contiguous: true,
      valid: true,
      bids: [{ price_usd: basePrice, quantity_btc: '1' }],
      asks: [
        { price_usd: (BigInt(basePrice) + 1n).toString(), quantity_btc: '1' },
      ],
    },
    {
      type: 'ticker',
      event_time_ms: cutoffMs,
      received_at_ms: cutoffMs,
      known_at_ms: cutoffMs,
      reception_order: receptionOrder + 3,
      mark_usd: basePrice,
      market_status: 'open',
      suspended: false,
    },
  )
  events.sort(
    (left, right) =>
      Number(left.received_at_ms) - Number(right.received_at_ms) ||
      Number(left.reception_order) - Number(right.reception_order),
  )
  events.forEach((event, index) => {
    event.reception_order = index + 1
  })
  return {
    mode: 'mock',
    instrument,
    decision_time_ms: cutoffMs,
    cutoff_received_at_ms: cutoffMs,
    events,
  }
}

function withKnownFunding(snapshot: Record<string, unknown>) {
  const now = Number(snapshot.decision_time_ms)
  const start = Math.floor(now / 3_600_000) * 3_600_000
  const observation = {
    source: 'runtime-test',
    provider: 'kraken',
    product: 'PF_XBTUSD',
    field: 'funding_rate',
    raw_rate: '0',
    unit: 'usd_per_btc_per_hour',
    effective_start_ms: start,
    effective_end_ms: start + 3_600_000,
    known_at_ms: now,
    received_seq: 1,
    observation_id: `funding-${now}`,
    sha256: 'a'.repeat(64),
    semantic_version: 'kraken-funding-normalization.v1',
    predicted: false,
  }
  ;(snapshot.events as Record<string, unknown>[]).push({
    type: 'funding_observation',
    received_at_ms: now,
    known_at_ms: now,
    observation,
  })
  return snapshot
}

function capturedPublicDepthFixture():
  | {
      readonly asks: { price_usd: string; quantity_btc: string }[]
      readonly bids: { price_usd: string; quantity_btc: string }[]
      readonly bookEventTimeMs: number
      readonly bookReceivedAtMs: number
      readonly decisionTimeMs: number
      readonly markUsd: string
      readonly sequence: number
      readonly tickerEventTimeMs: number
      readonly tickerReceivedAtMs: number
    }
  | undefined {
  const capturePath = join(
    process.cwd(),
    '../playwright-artifacts/futures-diagnostics/diag-20261003T221450Z-43308/public-frames.jsonl',
  )
  if (!existsSync(capturePath)) return undefined
  const frames = readFileSync(capturePath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { receivedAt: string; raw: string })
  const bookFrame = frames
    .map((frame) => ({
      frame,
      message: JSON.parse(frame.raw) as Record<string, unknown>,
    }))
    .find(({ message }) => message.feed === 'book_snapshot')
  const tickerFrame = frames
    .map((frame) => ({
      frame,
      message: JSON.parse(frame.raw) as Record<string, unknown>,
    }))
    .find(
      ({ message }) =>
        message.feed === 'ticker' && typeof message.markPrice === 'number',
    )
  if (!bookFrame || !tickerFrame) return undefined
  const book = bookFrame.message as Record<string, unknown> & {
    seq: number
  }
  const bookReceivedAtMs = Date.parse(bookFrame.frame.receivedAt)
  const tickerReceivedAtMs = Date.parse(tickerFrame.frame.receivedAt)
  const parsedBook = parseBookMessage(book, {
    receivedAt: bookReceivedAtMs,
    epoch: 1,
  })
  const parsedTicker = parseTickerMessage(tickerFrame.message, {
    receivedAt: tickerReceivedAtMs,
    epoch: 1,
  })
  return {
    asks: (parsedBook.asks ?? []).map(({ price, quantity }) => ({
      price_usd: price,
      quantity_btc: quantity,
    })),
    bids: (parsedBook.bids ?? []).map(({ price, quantity }) => ({
      price_usd: price,
      quantity_btc: quantity,
    })),
    bookEventTimeMs: parsedBook.eventTime,
    bookReceivedAtMs,
    decisionTimeMs: Math.max(bookReceivedAtMs, tickerReceivedAtMs),
    markUsd: parsedTicker.mark ?? '0',
    sequence: book.seq,
    tickerEventTimeMs: parsedTicker.eventTime,
    tickerReceivedAtMs,
  }
}
