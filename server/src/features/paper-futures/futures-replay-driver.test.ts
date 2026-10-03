import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FuturesReplayDriver,
  compareEconomicSemantics,
  type RuntimeWork,
} from './futures-replay-driver.ts'
import { FuturesCommandRunner } from './futures-command-runner.ts'
import { FuturesStore } from './futures-store.ts'
import { canonicalHash } from './futures-canonical.ts'
import type { FuturesWorkerRequest } from './futures-worker.ts'
import { FuturesMarketStore } from '../kraken-futures/futures-market-store.ts'

const directories: string[] = []
const instrument = {
  instrument_id: 'kraken-futures:PF_XBTUSD',
  provider_symbol: 'PF_XBTUSD',
  quantity_step_btc: '0.0001',
  minimum_quantity_btc: '0.0001',
  price_tick_usd: '1',
}
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
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

function pythonMarket(
  decisionTime: number,
  breakout: 'long' | 'short' | 'flat',
) {
  const root = resolve(import.meta.dirname, '../../../../')
  const script = `import json\nfrom futures_runtime_fixtures import warmed_market\nprint(json.dumps(warmed_market(${decisionTime}, breakout=${JSON.stringify(breakout)})))\n`
  const result = spawnSync('python3', ['-c', script], {
    cwd: root,
    env: { ...process.env, PYTHONPATH: `${root}/python:${root}/python/tests` },
    encoding: 'utf8',
  })
  if (result.status !== 0) throw new Error(result.stderr)
  return JSON.parse(result.stdout) as Record<string, unknown>
}

describe('shared causal futures replay driver', () => {
  it('does not retrofill late recovery evidence and resumes an open close intent on the first post-gap eligible book', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'futures-gap-replay-'))
    directories.push(directory)
    const start = 21_600_000
    const marketStore = new FuturesMarketStore(join(directory, 'market.sqlite'))
    const warm = pythonMarket(start, 'long')
    for (const candle of warm.events as Record<string, unknown>[]) {
      if (candle.type !== 'candle') continue
      marketStore.saveCandleRevision({
        id: `gap-warm:${candle.interval_ms}:${candle.bucket_start_ms}`,
        intervalMs: Number(candle.interval_ms),
        bucketStart: Number(candle.bucket_start_ms),
        revision: 1,
        knownAt: Number(candle.known_at_ms),
        closeAt: Number(candle.event_time_ms),
        isClosed: true,
        coverage: 'complete',
        open: String(candle.open),
        high: String(candle.high),
        low: String(candle.low),
        close: String(candle.close),
        volumeBtc: String(candle.volume_btc),
        tradeCount: 1,
        sourceHash: 'b'.repeat(64),
      })
    }
    const appendBook = (
      eventTime: number,
      receivedAt: number,
      seq: number,
      epoch = 1,
    ) =>
      marketStore.append({
        type: 'book',
        productId: 'PF_XBTUSD',
        seq,
        eventTime,
        receivedAt,
        persistedAt: receivedAt,
        epoch,
        snapshot: true,
        contiguous: true,
        valid: true,
        bids: [{ price: '100000', quantity: '1' }],
        asks: [{ price: '100001', quantity: '1' }],
        raw: { fixture: `book-${seq}` },
      })
    const appendTicker = (at: number, seq: number, lateFunding = false) =>
      marketStore.append({
        type: 'ticker',
        productId: 'PF_XBTUSD',
        seq,
        eventTime: at,
        receivedAt: at,
        persistedAt: at,
        epoch: 1,
        mark: '100000',
        suspended: false,
        ...(lateFunding
          ? {
              fundingObservation: {
                source: 'late-recovered-fixture',
                provider: 'kraken',
                product: 'PF_XBTUSD',
                field: 'funding_rate',
                raw_rate: '0',
                unit: 'provider-unresolved',
                effective_start_ms: start,
                effective_end_ms: start + 100,
                known_at_ms: at,
                received_seq: seq,
                observation_id: 'late-funding-after-cutoff',
                sha256: 'c'.repeat(64),
                semantic_version: 'kraken-funding-normalization.v1',
                predicted: false,
              },
            }
          : {}),
        raw: { fixture: `ticker-${seq}` },
      })
    appendBook(start, start, 1)
    appendTicker(start, 1)
    appendBook(start + 100, start + 100, 2)
    marketStore.appendGap({
      feed: 'book',
      productId: 'PF_XBTUSD',
      epoch: 1,
      expectedSeq: 3,
      actualSeq: 4,
      detectedAt: start + 200,
      reason: 'fixture sequence gap',
      policyVersion: 'snapshot-contiguous-observed.v1',
    })
    marketStore.append({
      type: 'trade',
      productId: 'PF_XBTUSD',
      seq: 50,
      eventTime: start + 150,
      receivedAt: start + 250,
      persistedAt: start + 250,
      epoch: 1,
      uid: 'late-recovered-trade',
      side: 'buy',
      tradeType: 'fill',
      quantityBtc: '50',
      priceUsd: '90000',
      recovered: true,
      raw: { fixture: 'late-recovered-trade' },
    })
    appendBook(start + 150, start + 250, 51)
    appendTicker(start + 250, 2, true)
    marketStore.saveCandleRevision({
      id: 'late-old-candle-after-gap',
      intervalMs: 60_000,
      bucketStart: start - 10 * 60_000,
      revision: 1,
      knownAt: start + 300,
      closeAt: start - 9 * 60_000,
      isClosed: true,
      coverage: 'complete',
      open: '100000',
      high: '150000',
      low: '50000',
      close: '100000',
      volumeBtc: '999',
      tradeCount: 999,
      sourceHash: 'd'.repeat(64),
    })
    appendBook(start + 300, start + 300, 4, 2)
    appendTicker(start + 300, 3)
    appendBook(start + 400, start + 400, 5, 2)

    const sourceHash = canonicalHash({
      events: marketStore.eventsAsOf(Number.MAX_SAFE_INTEGER),
      candles: marketStore.candlesAsOf(Number.MAX_SAFE_INTEGER),
      gaps: marketStore.gapsAsOf(Number.MAX_SAFE_INTEGER),
    })
    const manifest = {
      schema_version: 'futures-replay-manifest.v1' as const,
      source: 'gap-late-recovery-fixture',
      source_hash: sourceHash,
      config_hash: canonicalHash(runtimeConfig),
      seed: 'fixed-cash-once',
      fidelity: 'complete-mock-ohlc-gap-recovered-book.v1',
      runtime_version: 'futures-runtime-risk.v1',
      instrument_hash: canonicalHash(instrument),
    }
    const strategies = {
      config_version: 'futures-strategies-config.v1',
      indicator_version: 'futures-closed-indicators.v1',
      strategy_ids: [
        'c25-pullback-perp-v1',
        'c26-reversion-perp-v1',
        'c27-breakout-perp-v1',
        'c28-adapter-perp-v1',
      ],
    }
    const run = async (runId: string, incremental: boolean) => {
      const dbPath = join(directory, `${runId}.sqlite`)
      let store = new FuturesStore(dbPath)
      const createRun = () =>
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
            schema_version: 'futures-runtime-binding.v4',
            runtime_config: runtimeConfig,
            instrument_spec: instrument,
            strategy_manifest: strategies,
            strategy_config_hash: canonicalHash(strategies),
          },
        })
      createRun()
      let runner = new FuturesCommandRunner(store)
      const apply = async (work: RuntimeWork) => {
        const request: FuturesWorkerRequest = {
          request_id: `request-${work.work_id}`,
          run_id: runId,
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
            ...(work.input.payload.control
              ? {
                  control: work.input.payload.control as Record<
                    string,
                    unknown
                  >,
                }
              : {}),
          },
        }
        try {
          await runner.accept(request).result
        } catch (error) {
          const snapshot = work.input.payload.market_snapshot as Record<
            string,
            unknown
          >
          throw new Error(
            `gap source row ${work.input.sequence} candles=${(snapshot.events as Record<string, unknown>[]).filter((event) => event.type === 'candle').length}: ${String(error)}`,
            {
              cause: error,
            },
          )
        }
        const projection = store.getRunProjection(runId)
        const runtimeOutput = (
          store.exportRun(runId).runtime_outputs as Record<string, unknown>[]
        ).at(-1)
        return {
          status: 'committed' as const,
          applied_state_version: Number(projection?.state_version),
          economic_projection: {
            runtime_output: runtimeOutput,
            ledger: projection?.result,
          },
        }
      }
      const controlForSource = (source: Record<string, unknown>) =>
        Number(source.receivedSequence) === 6
          ? { type: 'paper.close' }
          : undefined
      let result
      if (incremental) {
        let driver = new FuturesReplayDriver({
          runId,
          manifest,
          apply,
          durableStore: store,
        })
        await driver.processMarketStore(marketStore, start + 100, instrument)
        await driver.processMarketStore(
          marketStore,
          start + 250,
          instrument,
          controlForSource,
        )
        const pending = store.getRunProjection(runId)?.checkpoint as Record<
          string,
          unknown
        >
        const positionBeforeRestart = pending.ledger_position as Record<
          string,
          unknown
        >
        expect(positionBeforeRestart.side).toBe('long')
        const execution = pending.execution_checkpoint as Record<
          string,
          unknown
        >
        expect(
          Object.values(
            execution.orders as Record<string, Record<string, unknown>>,
          ).some(
            (order) =>
              order.state === 'accepted' &&
              order.eligible_at_ms === start + 350,
          ),
        ).toBe(true)
        await runner.close()
        store.close()
        store = new FuturesStore(dbPath)
        createRun()
        runner = new FuturesCommandRunner(store)
        driver = await FuturesReplayDriver.resumeMarketStore({
          runId,
          manifest,
          apply,
          durableStore: store,
          marketStore,
          receivedCutoff: start + 300,
          instrument,
          controlForSource,
        })
        await driver.processMarketStore(
          marketStore,
          start + 400,
          instrument,
          controlForSource,
        )
        result = driver.exportRun()
      } else {
        result = await FuturesReplayDriver.replayMarketStore({
          runId,
          manifest,
          apply,
          store: marketStore,
          receivedCutoff: start + 400,
          instrument,
          controlForSource,
        })
      }
      const outputs = store.exportRun(runId).runtime_outputs as Record<
        string,
        unknown
      >[]
      const finalOutput = outputs.at(-1)!
      const projection = store.getRunProjection(runId)
      expect(store.verifyRun(runId)).toBe(true)
      await runner.close()
      store.close()
      return { result, outputs, finalOutput, projection }
    }

    const incremental = await run('gap-incremental', true)
    const batch = await run('gap-batch', false)
    expect(
      compareEconomicSemantics(incremental.result, batch.result),
    ).toMatchObject({ equal: true, differences: [] })
    expect(incremental.finalOutput.position).toMatchObject({
      side: null,
      quantity_btc: '0',
    })
    expect(incremental.finalOutput.ledger).toMatchObject({
      funding_complete: false,
      net_complete: null,
    })
    const resumedInputs = incremental.result.inputs as Record<string, unknown>[]
    const postGap = resumedInputs.find((input) => input.sequence === 7)!
      .payload as Record<string, unknown>
    const postGapSnapshot = postGap.market_snapshot as Record<string, unknown>
    const postGapEvents = postGapSnapshot.events as Record<string, unknown>[]
    expect(
      postGapEvents.some(
        (event) =>
          event.source_receipt_sequence === 4 && event.type === 'trade',
      ),
    ).toBe(false)
    expect(
      postGapEvents.some(
        (event) => event.type === 'candle' && event.known_at_ms === start + 300,
      ),
    ).toBe(false)
    expect(
      postGapEvents.some(
        (event) =>
          event.type === 'recovered_trade_audit' &&
          event.source_receipt_sequence === 4,
      ),
    ).toBe(true)
    expect(incremental.result.inputs.map((input) => input.sequence)).toContain(
      9,
    )
    marketStore.close()
  })

  it.each([
    { side: 'long' as const, rate1: '0.01', rate2: '0.02' },
    { side: 'short' as const, rate1: '-0.01', rate2: '-0.02' },
  ])(
    'replays a fully closed $side with rate change, partial reduce, restart, and independent Decimal reconciliation',
    async ({ side, rate1, rate2 }) => {
      const directory = mkdtempSync(join(tmpdir(), `futures-${side}-replay-`))
      directories.push(directory)
      const start = 86_400_000 + 23 * 3_600_000 + 30 * 60_000
      const marketPath = join(directory, 'market.sqlite')
      const marketStore = new FuturesMarketStore(marketPath)
      const warm = pythonMarket(start, side)
      for (const candle of warm.events as Record<string, unknown>[]) {
        if (candle.type !== 'candle') continue
        marketStore.saveCandleRevision({
          id: `warm:${candle.interval_ms}:${candle.bucket_start_ms}`,
          intervalMs: Number(candle.interval_ms),
          bucketStart: Number(candle.bucket_start_ms),
          revision: 1,
          knownAt: Number(candle.known_at_ms),
          closeAt: Number(candle.event_time_ms),
          isClosed: true,
          coverage: 'complete',
          open: String(candle.open),
          high: String(candle.high),
          low: String(candle.low),
          close: String(candle.close),
          volumeBtc: String(candle.volume_btc),
          tradeCount: 1,
          sourceHash: 'a'.repeat(64),
        })
      }
      const book = (at: number, seq: number, depth = '1', epoch = 1) =>
        marketStore.append({
          type: 'book',
          productId: 'PF_XBTUSD',
          seq,
          eventTime: at,
          receivedAt: at,
          persistedAt: at,
          epoch,
          snapshot: true,
          contiguous: true,
          valid: true,
          bids: [{ price: '100000', quantity: depth }],
          asks: [{ price: '100001', quantity: depth }],
          raw: { fixture: `${side}-book-${seq}` },
        })
      const ticker = (
        at: number,
        seq: number,
        intervalStart = at,
        intervalEnd = at,
        rate?: string,
      ) =>
        marketStore.append({
          type: 'ticker',
          productId: 'PF_XBTUSD',
          seq,
          eventTime: at,
          receivedAt: at,
          persistedAt: at,
          epoch: 1,
          mark: '100000',
          last: '100000',
          suspended: false,
          ...(rate === undefined
            ? {}
            : {
                fundingObservation: {
                  source: 'fixture-absolute-rate',
                  provider: 'kraken',
                  product: 'PF_XBTUSD',
                  field: 'funding_rate',
                  raw_rate: rate,
                  unit: 'usd_per_btc_per_hour',
                  effective_start_ms: intervalStart,
                  effective_end_ms: intervalEnd,
                  known_at_ms: intervalStart,
                  received_seq: seq,
                  observation_id: `${side}-funding-${seq}`,
                  sha256: String(seq).padStart(64, '0'),
                  semantic_version: 'kraken-funding-normalization.v1',
                  predicted: false,
                },
              }),
          raw: { fixture: `${side}-ticker-${seq}` },
        })

      book(start, 1)
      ticker(start, 1, start, start + 30 * 60_000, rate1)
      book(start + 100, 2)
      ticker(
        start + 30 * 60_000,
        2,
        start + 30 * 60_000,
        start + 60 * 60_000,
        rate2,
      )
      book(start + 30 * 60_000, 3)
      book(start + 30 * 60_000 + 100, 4, '0.0049')
      ticker(start + 31 * 60_000, 3)
      book(start + 31 * 60_000, 5)
      book(start + 31 * 60_000 + 100, 6)
      ticker(start + 32 * 60_000, 4)
      ticker(start + 32 * 60_000 + 1, 5)

      const sourceHash = canonicalHash({
        events: marketStore.eventsAsOf(Number.MAX_SAFE_INTEGER),
        candles: marketStore.candlesAsOf(Number.MAX_SAFE_INTEGER),
        gaps: marketStore.gapsAsOf(Number.MAX_SAFE_INTEGER),
      })
      const manifest = {
        schema_version: 'futures-replay-manifest.v1' as const,
        source: `${side}-closed-runtime-fixture`,
        source_hash: sourceHash,
        config_hash: canonicalHash(runtimeConfig),
        seed: 'fixed-cash-once',
        fidelity: 'complete-mock-ohlc-observed-book-funding.v1',
        runtime_version: 'futures-runtime-risk.v1',
        instrument_hash: canonicalHash(instrument),
      }
      const strategies = {
        config_version: 'futures-strategies-config.v1',
        indicator_version: 'futures-closed-indicators.v1',
        strategy_ids: [
          'c25-pullback-perp-v1',
          'c26-reversion-perp-v1',
          'c27-breakout-perp-v1',
          'c28-adapter-perp-v1',
        ],
      }
      const end = start + 32 * 60_000 + 1
      const applyRun = async (runId: string, incremental: boolean) => {
        const dbPath = join(directory, `${runId}.sqlite`)
        let store = new FuturesStore(dbPath)
        const createRun = () =>
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
              schema_version: 'futures-runtime-binding.v4',
              runtime_config: runtimeConfig,
              instrument_spec: instrument,
              strategy_manifest: strategies,
              strategy_config_hash: canonicalHash(strategies),
            },
          })
        createRun()
        let runner = new FuturesCommandRunner(store)
        const apply = async (work: RuntimeWork) => {
          const request: FuturesWorkerRequest = {
            request_id: `request-${work.work_id}`,
            run_id: runId,
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
              ...(work.input.payload.control
                ? {
                    control: work.input.payload.control as Record<
                      string,
                      unknown
                    >,
                  }
                : {}),
            },
          }
          try {
            await runner.accept(request).result
          } catch (error) {
            throw new Error(
              `source row ${work.input.sequence}: ${String(error)}`,
              { cause: error },
            )
          }
          const projection = store.getRunProjection(runId)
          const outputs = store.exportRun(runId).runtime_outputs as Record<
            string,
            unknown
          >[]
          const runtimeOutput = outputs.at(-1)!
          return {
            status: 'committed' as const,
            applied_state_version: Number(projection?.state_version),
            economic_projection: {
              runtime_output: runtimeOutput,
              ledger: projection?.result,
            },
          }
        }
        const controlForSource = (source: Record<string, unknown>) =>
          [5, 8].includes(Number(source.receivedSequence))
            ? { type: 'paper.close' }
            : undefined
        let result
        let checkpointAfterPartial: Record<string, unknown> | undefined
        let restoredAnalysisIds: string[] = []
        if (incremental) {
          let driver = new FuturesReplayDriver({
            runId,
            manifest,
            apply,
            durableStore: store,
          })
          await driver.processMarketStore(marketStore, start + 100, instrument)
          await driver.processMarketStore(
            marketStore,
            start + 30 * 60_000,
            instrument,
            controlForSource,
          )
          await driver.processMarketStore(
            marketStore,
            start + 30 * 60_000 + 100,
            instrument,
            controlForSource,
          )
          checkpointAfterPartial = store.getRunProjection(runId)
            ?.checkpoint as Record<string, unknown>
          await runner.close()
          store.close()
          store = new FuturesStore(dbPath)
          createRun()
          runner = new FuturesCommandRunner(store)
          driver = await FuturesReplayDriver.resumeMarketStore({
            runId,
            manifest,
            apply,
            durableStore: store,
            marketStore,
            receivedCutoff: start + 30 * 60_000 + 100,
            instrument,
            controlForSource,
          })
          const headAtRestore = store.exportRun(runId).head_hash
          const effectsAtRestore = (store.exportRun(runId).events as unknown[])
            .length
          restoredAnalysisIds = driver
            .exportRun()
            .work.map((work) => work.analysis_id)
          await driver.processMarketStore(
            marketStore,
            start + 30 * 60_000 + 100,
            instrument,
            controlForSource,
          )
          expect(store.exportRun(runId).head_hash).toBe(headAtRestore)
          expect((store.exportRun(runId).events as unknown[]).length).toBe(
            effectsAtRestore,
          )
          expect(
            driver.exportRun().work.map((work) => work.analysis_id),
          ).toEqual(restoredAnalysisIds)
          await driver.processMarketStore(
            marketStore,
            end,
            instrument,
            controlForSource,
          )
          result = driver.exportRun()
        } else {
          result = await FuturesReplayDriver.replayMarketStore({
            runId,
            manifest,
            apply,
            store: marketStore,
            receivedCutoff: end,
            instrument,
            controlForSource,
          })
        }
        const database = store.exportRun(runId)
        const finalProjection = store.getRunProjection(runId)
        expect(store.verifyRun(runId)).toBe(true)
        const workIds = result.work.map((work) => work.work_id)
        const outputSequence = (database.runtime_outputs as unknown[]).length
        await runner.close()
        store.close()
        return {
          result,
          database,
          finalProjection,
          checkpointAfterPartial,
          restoredAnalysisIds,
          workIds,
          outputSequence,
        }
      }

      const incremental = await applyRun(`${side}-incremental`, true)
      const batch = await applyRun(`${side}-batch`, false)
      expect(incremental.result.run_id).not.toBe(batch.result.run_id)
      expect(incremental.workIds).not.toEqual(batch.workIds)
      const semantic = compareEconomicSemantics(
        incremental.result,
        batch.result,
      )
      expect(semantic).toMatchObject({ equal: true, differences: [] })
      expect(incremental.checkpointAfterPartial).toBeDefined()
      const partialCheckpoint = incremental.checkpointAfterPartial!
      expect(partialCheckpoint.ledger_position).toMatchObject({
        side,
      })
      expect(['0.005', '0.0051']).toContain(
        (partialCheckpoint.ledger_position as Record<string, unknown>).qty,
      )
      expect(partialCheckpoint.cash_usd).toBe('10000')
      expect(
        (partialCheckpoint.risk_checkpoint as Record<string, unknown>).utc_day,
      ).toBe('1970-01-03')
      expect(incremental.restoredAnalysisIds.length).toBeGreaterThan(0)
      expect(incremental.result.inputs.map((input) => input.sequence)).toEqual(
        batch.result.inputs.map((input) => input.sequence),
      )
      const outputs = incremental.database.runtime_outputs as Record<
        string,
        unknown
      >[]
      const joined = JSON.stringify(outputs)
      expect(joined).toContain('futures-runtime-risk.v1')
      expect(
        (outputs[0]?.analysis as Record<string, unknown>).proposals,
      ).toHaveLength(4)
      const finalRuntime = outputs.at(-1) as Record<string, unknown>
      expect(finalRuntime.position).toMatchObject({
        side: null,
        quantity_btc: '0',
      })
      expect(finalRuntime.ledger).toMatchObject({
        decimal_precision: 50,
        cash_usd: '10000',
        funding_complete: true,
      })
      expect(incremental.outputSequence).toBe(outputs.length)

      const fills = outputs.flatMap((output) =>
        (output.fills as Record<string, string>[]).map((fill) => ({
          ...fill,
          position_side: side,
          purpose:
            (side === 'long' && fill.action === 'buy') ||
            (side === 'short' && fill.action === 'sell')
              ? 'entry'
              : 'close',
        })),
      )
      const referenceScript = String.raw`
import json, sys
from decimal import Decimal, localcontext
from balancita_engine.canonical import normalize_decimal
fills=json.load(sys.stdin)
with localcontext() as ctx:
 ctx.prec=50
 side=fills[0]['position_side']; sign=Decimal(1) if side=='long' else Decimal(-1)
 start=int(sys.argv[1]); half=start+30*60*1000
 rate1=Decimal(sys.argv[2]); rate2=Decimal(sys.argv[3])
 ordered=sorted(fills,key=lambda f:int(f['event_time_ms']))
 qty=Decimal(0); entry=Decimal(0); gross=Decimal(0); fees=Decimal(0); funding=Decimal(0); cursor=None
 def accrue(left,right,quantity):
  total=Decimal(0)
  if right<=left: return total
  first=min(right,half)
  if first>left: total += quantity*rate1*Decimal(first-left)/Decimal(3600000)*sign
  second=max(left,half)
  if right>second: total += quantity*rate2*Decimal(right-second)/Decimal(3600000)*sign
  return total
 for f in ordered:
  t=int(f['event_time_ms']); q=Decimal(f['quantity_btc']); p=Decimal(f['price_usd_per_btc']); fees+=Decimal(f['fee_usd'])
  if f['purpose']=='entry': qty+=q; entry=p; cursor=t
  else:
   funding+=accrue(cursor,t,qty)
   gross+=q*(p-entry)*sign; qty-=q; cursor=t
 equity=Decimal('10000')+gross-fees-funding
 print(json.dumps({'gross':normalize_decimal(str(gross)),'fees':normalize_decimal(str(fees)),'funding':normalize_decimal(str(funding)),'equity':normalize_decimal(str(equity)),'remaining':normalize_decimal(str(qty)) if qty else '0'}))
`
      const reference = spawnSync(
        'python3',
        ['-c', referenceScript, String(start), rate1, rate2],
        {
          cwd: resolve(import.meta.dirname, '../../../../'),
          env: {
            ...process.env,
            PYTHONPATH: `${resolve(import.meta.dirname, '../../../../')}/python`,
          },
          input: JSON.stringify(fills),
          encoding: 'utf8',
        },
      )
      expect(reference.status, reference.stderr).toBe(0)
      const independentlyReconciled = JSON.parse(reference.stdout) as Record<
        string,
        string
      >
      const finalLedger = finalRuntime.ledger as Record<string, unknown>
      expect(independentlyReconciled.gross).toBe(finalLedger.realized_gross_usd)
      expect(independentlyReconciled.fees).toBe(finalLedger.fees_usd)
      expect(independentlyReconciled.funding).toBe(finalLedger.funding_paid)
      expect(independentlyReconciled.equity).toBe(finalLedger.equity_usd)
      expect(independentlyReconciled.remaining).toBe('0')
      expect(Number(finalLedger.decimal_precision)).toBe(50)
      expect((finalLedger as Record<string, unknown>).funding_complete).toBe(
        true,
      )
      const funding = String(finalLedger.funding_paid)
      expect(funding.startsWith('-')).toBe(false)

      const mutations = [
        (changed: typeof incremental.result) => {
          const projections = changed.economic_projection as Record<
            string,
            unknown
          >[]
          const runtime = projections.find(
            (projection) =>
              (
                (projection.runtime_output as Record<string, unknown>)
                  .fills as unknown[]
              ).length > 0,
          )!.runtime_output as Record<string, unknown>
          ;(runtime.fills as Record<string, unknown>[])[0]!.price_usd_per_btc =
            '99999'
        },
        (changed: typeof incremental.result) => {
          const projections = changed.economic_projection as Record<
            string,
            unknown
          >[]
          const runtime = projections.find(
            (projection) =>
              (
                (projection.runtime_output as Record<string, unknown>)
                  .fills as unknown[]
              ).length > 0,
          )!.runtime_output as Record<string, unknown>
          ;(runtime.fills as Record<string, unknown>[])[0]!.fee_usd = '99'
        },
        (changed: typeof incremental.result) => {
          const runtime = (
            changed.economic_projection as Record<string, unknown>[]
          )[0]!.runtime_output as Record<string, unknown>
          const accepted = (
            runtime.execution_events as Record<string, unknown>[]
          ).find((event) => event.type === 'order_accepted')!
          accepted.eligible_at_ms = Number(accepted.eligible_at_ms) + 1
        },
        (changed: typeof incremental.result) => {
          const runtime = (
            changed.economic_projection as Record<string, unknown>[]
          )[0]!.runtime_output as Record<string, unknown>
          const analysis = runtime.analysis as Record<string, unknown>
          ;(analysis.selector as Record<string, unknown>).action = 'FLAT'
        },
        (changed: typeof incremental.result) => {
          const payload = changed.inputs[0]!.payload as Record<string, unknown>
          payload.market_gaps = [
            { feed: 'book', detected_at: start, policy_version: 'control' },
          ]
        },
        (changed: typeof incremental.result) => {
          const runtime = (
            changed.economic_projection as Record<string, unknown>[]
          )[0]!.runtime_output as Record<string, unknown>
          runtime.runtime_version = 'futures-runtime-risk.changed'
        },
      ]
      for (const [index, mutate] of mutations.entries()) {
        const changed = structuredClone(incremental.result)
        mutate(changed)
        expect(
          compareEconomicSemantics(incremental.result, changed).equal,
          `control ${index}`,
        ).toBe(false)
      }
      expect(incremental.database.head_hash).toBeTruthy()
      marketStore.close()
    },
  )

  it('assigns a durable-shaped unique UUID to each distinct WAIT evidence cycle', async () => {
    const driver = new FuturesReplayDriver({
      runId: 'wait-cycle-identities',
      manifest: {
        schema_version: 'futures-replay-manifest.v1',
        source: 'fixture',
        source_hash: 'a'.repeat(64),
        config_hash: 'b'.repeat(64),
        seed: 'fixture',
        fidelity: 'ohlc-low.v1',
      },
      apply: async (work) => ({
        status: 'committed',
        applied_state_version: work.version + 1,
        economic_projection: { analysis: { action: 'WAIT' } },
      }),
    })
    const evidence = {
      received_at_ms: 10,
      event_time_ms: 10,
      payload: { market_snapshot_hash: 'c'.repeat(64), wait: true },
    }
    await driver.processEvent({ ...evidence, sequence: 1 })
    await driver.processEvent({ ...evidence, sequence: 2 })
    const works = driver.exportRun().work
    expect(works).toHaveLength(2)
    expect(new Set(works.map((work) => work.analysis_id)).size).toBe(2)
    expect(
      works.every((work) => /^[0-9a-f-]{36}$/i.test(work.analysis_id)),
    ).toBe(true)
    expect(works[0]?.cycle_key).not.toBe(works[1]?.cycle_key)
  })

  it('ingests persisted receipt-order market events and as-of candles into actual runtime work', async () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'futures-replay-market-source-'),
    )
    directories.push(directory)
    const marketStore = new FuturesMarketStore(join(directory, 'market.sqlite'))
    marketStore.append({
      type: 'book',
      productId: 'PF_XBTUSD',
      seq: 1,
      eventTime: 1000,
      receivedAt: 1010,
      persistedAt: 1011,
      epoch: 1,
      snapshot: true,
      contiguous: true,
      valid: true,
      bids: [{ price: '100000', quantity: '1' }],
      asks: [{ price: '100001', quantity: '1' }],
      raw: { fixture: true },
    })
    marketStore.append({
      type: 'ticker',
      productId: 'PF_XBTUSD',
      seq: 1,
      eventTime: 1000,
      receivedAt: 1010,
      persistedAt: 1011,
      epoch: 1,
      mark: '100000',
      suspended: false,
      funding: { status: 'unknown' },
      raw: { fixture: true },
    })
    const ordered = marketStore.eventsAsOf(1010) as Record<string, unknown>[]
    const driver = new FuturesReplayDriver({
      runId: 'persisted-market-red',
      manifest: {
        schema_version: 'futures-replay-manifest.v1',
        source: 'fixture',
        source_hash: 'a'.repeat(64),
        config_hash: 'b'.repeat(64),
        seed: 'fixture',
        fidelity: 'book-trade-ticker.v1',
      },
      apply: async (work) => ({
        status: 'committed',
        applied_state_version: work.version + 1,
      }),
    })
    expect(ordered[0]?.receivedSequence).toBe(1)
    await driver.processMarketStore(marketStore, 1010, instrument)
    expect(driver.exportRun().inputs[0]?.sequence).toBe(2)
    expect(driver.exportRun().inputs[0]?.payload.market_snapshot).toBeDefined()
    marketStore.close()
  })

  it('runs persisted market evidence through Python worker and Node SQLite for incremental and batch runs', async () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'futures-persisted-market-e2e-'),
    )
    directories.push(directory)
    const marketStore = new FuturesMarketStore(join(directory, 'market.sqlite'))
    const start = 21_600_000
    const warm = pythonMarket(start, 'long')
    const warmEvents = warm.events as Record<string, unknown>[]
    for (const candle of warmEvents.filter(
      (event) => event.type === 'candle',
    )) {
      marketStore.saveCandleRevision({
        id: `fixture:${candle.interval_ms}:${candle.bucket_start_ms}`,
        intervalMs: Number(candle.interval_ms),
        bucketStart: Number(candle.bucket_start_ms),
        revision: 1,
        knownAt: Number(candle.known_at_ms),
        closeAt: Number(candle.event_time_ms),
        isClosed: true,
        coverage: 'complete',
        open: String(candle.open),
        high: String(candle.high),
        low: String(candle.low),
        close: String(candle.close),
        volumeBtc: String(candle.volume_btc),
        tradeCount: 1,
        sourceHash: 'c'.repeat(64),
      })
    }
    const appendBook = (at: number, seq: number, bid: string, ask: string) =>
      marketStore.append({
        type: 'book',
        productId: 'PF_XBTUSD',
        seq,
        eventTime: at,
        receivedAt: at,
        persistedAt: at,
        epoch: 1,
        snapshot: true,
        contiguous: true,
        valid: true,
        bids: [{ price: bid, quantity: '1' }],
        asks: [{ price: ask, quantity: '1' }],
        raw: { fixture: 'book' },
      })
    marketStore.append({
      type: 'trade',
      productId: 'PF_XBTUSD',
      seq: 1,
      eventTime: start - 1,
      receivedAt: start,
      persistedAt: start,
      epoch: 1,
      uid: 'fixture-trade-1',
      side: 'buy',
      tradeType: 'fill',
      quantityBtc: '0.001',
      priceUsd: '100000',
      recovered: false,
      raw: { fixture: 'trade' },
    })
    appendBook(start, 1, '100000', '100001')
    marketStore.append({
      type: 'ticker',
      productId: 'PF_XBTUSD',
      seq: 1,
      eventTime: start,
      receivedAt: start,
      persistedAt: start,
      epoch: 1,
      mark: '100000',
      last: '100000',
      suspended: false,
      fundingObservation: {
        source: 'fixture',
        provider: 'kraken',
        product: 'PF_XBTUSD',
        field: 'funding_rate',
        raw_rate: '0',
        unit: 'usd_per_btc_per_hour',
        effective_start_ms: start,
        effective_end_ms: start + 3_600_000,
        known_at_ms: start,
        received_seq: 3,
        observation_id: 'fixture-zero',
        sha256: 'd'.repeat(64),
        semantic_version: 'kraken-funding-normalization.v1',
        predicted: false,
      },
      raw: { fixture: 'ticker' },
    })
    appendBook(start + 100, 2, '100000', '100001')
    appendBook(start + 101, 3, '100000', '100001')
    appendBook(start + 201, 4, '100000', '100001')
    appendBook(start + 301, 5, '100000', '100001')
    marketStore.saveCandleRevision({
      id: 'fixture:60000:future',
      intervalMs: 60_000,
      bucketStart: start + 60_000,
      revision: 1,
      knownAt: start + 101,
      closeAt: start + 120_000,
      isClosed: true,
      coverage: 'complete',
      open: '100000',
      high: '100001',
      low: '99999',
      close: '100000',
      volumeBtc: '1',
      tradeCount: 1,
      sourceHash: 'e'.repeat(64),
    })
    const sourceHash = canonicalHash({
      events: marketStore.eventsAsOf(Number.MAX_SAFE_INTEGER),
      candles: marketStore.candlesAsOf(Number.MAX_SAFE_INTEGER),
      gaps: marketStore.gapsAsOf(Number.MAX_SAFE_INTEGER),
    })
    const manifest = {
      schema_version: 'futures-replay-manifest.v1' as const,
      source: 'persisted-fixture-market-store',
      source_hash: sourceHash,
      config_hash: canonicalHash(runtimeConfig),
      seed: 'fixture-seed',
      fidelity: 'fixture-complete-ohlc-plus-observed-book-trade-ticker.v1',
      runtime_version: 'futures-runtime-risk.v1',
      instrument_hash: canonicalHash(instrument),
    }
    const manifestData = {
      config_version: 'futures-strategies-config.v1',
      indicator_version: 'futures-closed-indicators.v1',
      strategy_ids: [
        'c25-pullback-perp-v1',
        'c26-reversion-perp-v1',
        'c27-breakout-perp-v1',
        'c28-adapter-perp-v1',
      ],
    }
    const run = async (runId: string, batch: boolean) => {
      const dbPath = join(directory, `${runId}.sqlite`)
      let store = new FuturesStore(dbPath)
      const createRun = () =>
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
            schema_version: 'futures-runtime-binding.v4',
            runtime_config: runtimeConfig,
            instrument_spec: instrument,
            strategy_manifest: manifestData,
            strategy_config_hash: canonicalHash(manifestData),
          },
        })
      createRun()
      let runner = new FuturesCommandRunner(store)
      const audit: Record<string, unknown>[] = []
      const apply = async (work: RuntimeWork) => {
        const market = work.input.payload.market_snapshot as Record<
          string,
          unknown
        >
        const request: FuturesWorkerRequest = {
          request_id: `request-${work.work_id}`,
          run_id: runId,
          work_id: work.work_id,
          expected_state_version: work.version,
          payload: {
            operation: 'futures_runtime.v3',
            runtime_config: runtimeConfig,
            instrument,
            market_snapshot: market,
            ...(work.input.payload.control
              ? {
                  control: work.input.payload.control as Record<
                    string,
                    unknown
                  >,
                }
              : {}),
          },
        }
        await runner.accept(request).result
        const projection = store.getRunProjection(runId)
        const raw = store.exportRun(runId)
        const result = projection?.result as Record<string, unknown>
        const runtimeOutput = (
          raw.runtime_outputs as Record<string, unknown>[]
        ).at(-1)
        const checkpoint = projection?.checkpoint as Record<string, unknown>
        const execution = checkpoint.execution_checkpoint as Record<
          string,
          unknown
        >
        const pending = Object.values(
          execution.orders as Record<string, Record<string, unknown>>,
        ).find(
          (order) =>
            order.state === 'accepted' || order.state === 'partially_filled',
        )
        audit.push({
          received_sequence: work.input.sequence,
          version: projection?.state_version,
          ledger: result,
          quantity_btc:
            result.quantity_btc ??
            (result.position as Record<string, unknown> | undefined)
              ?.quantity_btc,
          eligible_at_ms: pending?.eligible_at_ms,
          runtime_output: runtimeOutput,
          fills: raw.events,
        })
        return {
          status: 'committed' as const,
          applied_state_version: Number(projection?.state_version),
          economic_projection: {
            ledger: projection?.result,
            runtime_output: runtimeOutput,
            events: raw.events,
          },
        }
      }
      const common = {
        runId,
        manifest,
        apply,
        store: marketStore,
        receivedCutoff: start + 301,
        instrument,
        controlForSource: (source: Record<string, unknown>) =>
          Number(source.receivedSequence) === 5
            ? { type: 'paper.close' }
            : undefined,
      }
      let result
      if (batch) {
        result = await FuturesReplayDriver.replayMarketStore(common)
      } else {
        let driver = new FuturesReplayDriver({
          runId,
          manifest,
          apply,
          durableStore: store,
        })
        await driver.processMarketStore(marketStore, start, instrument)
        expect(
          driver.exportRun().inputs.map((input) => input.sequence),
        ).toEqual([3])
        const beforeRestart = store.getRunProjection(runId)
        const pendingCheckpoint = beforeRestart?.checkpoint as Record<
          string,
          unknown
        >
        const pendingExecution =
          pendingCheckpoint.execution_checkpoint as Record<string, unknown>
        const pendingOrders = Object.values(
          pendingExecution.orders as Record<string, Record<string, unknown>>,
        )
        expect(
          pendingOrders.some((order) => order.eligible_at_ms === start + 100),
        ).toBe(true)
        await runner.close()
        store.close()

        store = new FuturesStore(dbPath)
        createRun()
        runner = new FuturesCommandRunner(store)
        driver = await FuturesReplayDriver.resumeMarketStore({
          runId,
          manifest,
          apply,
          durableStore: store,
          marketStore,
          receivedCutoff: start,
          instrument,
        })
        expect(
          driver.exportRun().inputs.map((input) => input.sequence),
        ).toEqual([3])
        const restoredPending = store.getRunProjection(runId)
          ?.checkpoint as Record<string, unknown>
        const restoredExecution =
          restoredPending.execution_checkpoint as Record<string, unknown>
        const restoredOrders = Object.values(
          restoredExecution.orders as Record<string, Record<string, unknown>>,
        )
        expect(
          restoredOrders.some((order) => order.eligible_at_ms === start + 100),
        ).toBe(true)
        expect(
          store.loadReplaySession(runId, {
            schema_version: 'futures-replay-session.v1',
            run_id: runId,
            manifest,
            instrument_hash: canonicalHash(instrument),
          }).cursor,
        ).toBe(3)
        const headBeforeRetry = store.exportRun(runId).head_hash
        const effectsBeforeRetry = (store.exportRun(runId).events as unknown[])
          .length
        await expect(
          driver.processEvent({
            sequence: 2,
            received_at_ms: start,
            event_time_ms: start,
            payload: { invalid_cursor_probe: true },
          }),
        ).rejects.toThrow(
          'Causal inputs must arrive in persisted receive order.',
        )
        expect(store.exportRun(runId).head_hash).toBe(headBeforeRetry)
        expect((store.exportRun(runId).events as unknown[]).length).toBe(
          effectsBeforeRetry,
        )
        await expect(
          FuturesReplayDriver.resumeMarketStore({
            runId,
            manifest: { ...manifest, source_hash: 'f'.repeat(64) },
            apply,
            durableStore: store,
            marketStore,
            receivedCutoff: start,
            instrument,
          }),
        ).rejects.toThrow(
          'Replay dataset hash does not match the frozen manifest.',
        )
        await expect(
          FuturesReplayDriver.resumeMarketStore({
            runId,
            manifest: { ...manifest, config_hash: 'f'.repeat(64) },
            apply,
            durableStore: store,
            marketStore,
            receivedCutoff: start,
            instrument,
          }),
        ).rejects.toThrow(
          'Replay session does not match the frozen runtime binding.',
        )
        expect(store.exportRun(runId).head_hash).toBe(headBeforeRetry)
        expect((store.exportRun(runId).events as unknown[]).length).toBe(
          effectsBeforeRetry,
        )
        const analysesBeforeRetry = driver
          .exportRun()
          .work.map((work) => work.analysis_id)
        await driver.processMarketStore(marketStore, start, instrument)
        expect(store.exportRun(runId).head_hash).toBe(headBeforeRetry)
        expect((store.exportRun(runId).events as unknown[]).length).toBe(
          effectsBeforeRetry,
        )
        expect(driver.exportRun().work.map((work) => work.analysis_id)).toEqual(
          analysesBeforeRetry,
        )
        await driver.processMarketStore(
          marketStore,
          start + 301,
          instrument,
          (source) =>
            Number(source.receivedSequence) === 5
              ? { type: 'paper.close' }
              : undefined,
        )
        result = driver.exportRun()
        expect(result.inputs.map((input) => input.sequence)).toEqual([
          3, 4, 5, 6, 7,
        ])
        expect(store.exportRun(runId).head_hash).not.toBe(headBeforeRetry)
        expect(
          (store.exportRun(runId).events as unknown[]).length,
        ).toBeGreaterThan(effectsBeforeRetry)
        expect(store.verifyRun(runId)).toBe(true)
        const session = store.loadReplaySession(runId, {
          schema_version: 'futures-replay-session.v1',
          run_id: runId,
          manifest,
          instrument_hash: canonicalHash(instrument),
        })
        expect(session.cursor).toBe(7)
        expect(session.works).toHaveLength(5)
      }
      await runner.close()
      store.close()
      const fills = result.economic_projection as Record<string, unknown>[]
      return { result, audit, fills }
    }
    const incremental = await run('stored-incremental', false)
    const batch = await run('stored-batch', true)
    expect(incremental.result.run_id).not.toBe(batch.result.run_id)
    expect(incremental.result.manifest_hash).toBe(batch.result.manifest_hash)
    expect(incremental.result.work.map((work) => work.work_id)).not.toEqual(
      batch.result.work.map((work) => work.work_id),
    )
    const semanticComparison = compareEconomicSemantics(
      incremental.result,
      batch.result,
    )
    expect(semanticComparison.differences).toEqual([])
    expect(incremental.result.inputs.map((input) => input.sequence)).toEqual([
      3, 4, 5, 6, 7,
    ])
    expect(incremental.audit.map((entry) => entry.received_sequence)).toEqual([
      3, 4, 5, 6, 7,
    ])
    expect(incremental.audit[0]).toMatchObject({
      quantity_btc: '0',
      eligible_at_ms: start + 100,
    })
    expect(incremental.audit[1]?.quantity_btc).toBe('0.0099')
    expect(incremental.audit[2]).toMatchObject({
      quantity_btc: '0.0099',
      eligible_at_ms: start + 201,
    })
    const closeIntent = (
      incremental.audit[2]?.fills as Record<string, unknown>[]
    ).find(
      (event) => event.type === 'order' && event.order_type === 'reduce_only',
    )
    expect(closeIntent).toMatchObject({
      side: 'sell',
      order_type: 'reduce_only',
    })
    expect(closeIntent).not.toHaveProperty('limit_price_usd')
    expect(closeIntent).not.toHaveProperty('price_usd')
    expect(incremental.audit[3]?.quantity_btc).toBe('0')
    expect(
      (incremental.audit[4]?.runtime_output as Record<string, unknown>)
        .analysis,
    ).toMatchObject({ action: 'WAIT' })
    expect(
      incremental.result.inputs.every((input) => {
        const event = input.payload.market_event as Record<string, unknown>
        const snapshot = input.payload.market_snapshot as Record<
          string,
          unknown
        >
        const candles = snapshot.events as Record<string, unknown>[]
        return (
          Number(event.receivedSequence) === input.sequence &&
          candles
            .filter((candle) => candle.type === 'candle')
            .every((candle) => Number(candle.bucket_start_ms) <= start)
        )
      }),
    ).toBe(true)
    const firstSnapshot = incremental.result.inputs[0]!.payload
      .market_snapshot as Record<string, unknown>
    const firstSnapshotEvents = firstSnapshot.events as Record<
      string,
      unknown
    >[]
    expect(firstSnapshotEvents.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'trade',
        'book_snapshot',
        'ticker',
        'funding_observation',
        'candle',
      ]),
    )
    expect(
      firstSnapshotEvents
        .filter((event) => event.source_receipt_sequence !== undefined)
        .map((event) => event.source_receipt_sequence),
    ).toEqual([1, 2, 3])
    expect(
      (incremental.audit[1]?.fills as Record<string, unknown>[]).find(
        (event) => event.type === 'fill',
      ),
    ).toMatchObject({
      price_usd_per_btc: '100001',
      fee_usd: '0.49500495',
      quantity_btc: '0.0099',
    })
    expect(
      (incremental.audit[3]?.fills as Record<string, unknown>[]).filter(
        (event) => event.type === 'fill',
      ),
    ).toHaveLength(2)
    expect(
      (incremental.audit[3]?.fills as Record<string, unknown>[]).find(
        (event) =>
          event.type === 'fill' && event.price_usd_per_btc === '100000',
      ),
    ).toMatchObject({ quantity_btc: '0.0099', fee_usd: '0.495' })
    expect(incremental.audit[3]?.ledger).toMatchObject({
      quantity_btc: '0',
      fees_usd: '0.99000495',
      realized_net_complete: '-0.99990495',
    })
    const analysisIds = incremental.result.work.map((work) => work.analysis_id)
    expect(new Set(analysisIds).size).toBe(analysisIds.length)
    expect(analysisIds.every((id) => /^[0-9a-f-]{36}$/i.test(id))).toBe(true)
    expect(JSON.stringify(incremental.result.economic_projection)).toContain(
      '0.0099',
    )
    expect(JSON.stringify(incremental.result.economic_projection)).toContain(
      '0.49500495',
    )
    marketStore.close()
  }, 30_000)
  it('uses one process core for incremental and batch inputs and excludes only generated identities', async () => {
    const requests: string[] = []
    const driver = new FuturesReplayDriver({
      runId: 'run-a',
      manifest: {
        schema_version: 'futures-replay-manifest.v1',
        source: 'fixture',
        source_hash: 'a'.repeat(64),
        config_hash: 'b'.repeat(64),
        seed: 'fixture-seed',
        fidelity: 'ohlc-low.v1',
      },
      apply: async (work) => {
        requests.push(work.work_id)
        return { status: 'committed', applied_state_version: work.version + 1 }
      },
    })
    const inputs = [
      {
        sequence: 1,
        received_at_ms: 100,
        event_time_ms: 90,
        payload: { n: 1 },
      },
      {
        sequence: 2,
        received_at_ms: 200,
        event_time_ms: 80,
        payload: { n: 2 },
      },
    ]

    await driver.processEvent(inputs[0]!)
    await driver.processEvent(inputs[1]!)
    const incremental = driver.exportRun()

    const batch = await FuturesReplayDriver.replay({
      runId: 'run-b',
      manifest: driver.manifest,
      inputs,
      apply: async (work) => ({
        status: 'committed',
        applied_state_version: work.version + 1,
      }),
    })

    expect(requests).toHaveLength(2)
    expect(incremental.inputs.map((input) => input.sequence)).toEqual([1, 2])
    expect(compareEconomicSemantics(incremental, batch).equal).toBe(true)
    expect(incremental.run_id).not.toBe(batch.run_id)
    expect(incremental.manifest_hash).toBe(batch.manifest_hash)
  })

  it('excludes late knowledge and reports semantic changes instead of erasing economics', async () => {
    const driver = new FuturesReplayDriver({
      runId: 'run-late',
      manifest: {
        schema_version: 'futures-replay-manifest.v1',
        source: 'fixture',
        source_hash: 'a'.repeat(64),
        config_hash: 'b'.repeat(64),
        seed: 'fixture-seed',
        fidelity: 'ohlc-low.v1',
      },
      apply: async (work) => ({
        status: 'committed',
        applied_state_version: work.version + 1,
      }),
    })
    await driver.processEvent(
      {
        sequence: 1,
        received_at_ms: 101,
        event_time_ms: 90,
        known_at_ms: 101,
        payload: { price: '101' },
      },
      100,
    )
    expect(driver.exportRun().inputs).toHaveLength(0)

    for (const [field, value] of [
      ['price_usd_per_btc', '101'],
      ['fee_usd', '0.02'],
      ['eligible_at_ms', 201],
    ] as const) {
      const left = {
        economic_projection: {
          fill: { [field]: field === 'eligible_at_ms' ? 200 : '100' },
        },
      }
      const right = { economic_projection: { fill: { [field]: value } } }
      expect(compareEconomicSemantics(left, right).equal).toBe(false)
      expect(compareEconomicSemantics(left, right).differences).toContain(
        `fill.${field}`,
      )
    }
  })

  it('deduplicates identical retries but keeps new evidence and stable market order', async () => {
    const driver = new FuturesReplayDriver({
      runId: 'run-retry',
      manifest: {
        schema_version: 'futures-replay-manifest.v1',
        source: 'fixture',
        source_hash: 'a'.repeat(64),
        config_hash: 'b'.repeat(64),
        seed: 'fixture-seed',
        fidelity: 'book-trade-funding.v1',
      },
      apply: async (work) => ({
        status: 'committed',
        applied_state_version: work.version + 1,
      }),
    })
    const first = {
      sequence: 1,
      received_at_ms: 100,
      event_time_ms: 100,
      cycle_key: 'trigger-1',
      payload: { wait: true },
    }
    await driver.processEvent(first)
    await driver.processEvent(first)
    await driver.processEvent({ ...first, sequence: 2, received_at_ms: 200 })
    expect(driver.exportRun().inputs).toHaveLength(2)
    expect(driver.exportRun().work).toHaveLength(2)
  })

  it('runs stream and batch through separate real Python workers and Node SQLite runs', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'futures-shared-replay-'))
    directories.push(directory)
    const markets = [
      pythonMarket(21_600_000, 'long'),
      pythonMarket(21_600_100, 'flat'),
    ]
    const inputs = markets.map((snapshot, index) => ({
      sequence: index + 1,
      received_at_ms: 21_600_000 + index * 100,
      event_time_ms: 21_600_000 + index * 100,
      known_at_ms: 21_600_000 + index * 100,
      payload: { market_snapshot: snapshot },
    }))
    const sourceHash = canonicalHash(inputs)
    const manifest = {
      schema_version: 'futures-replay-manifest.v1' as const,
      source: 'deterministic-python-fixture',
      source_hash: sourceHash,
      config_hash: canonicalHash(runtimeConfig),
      seed: 'fixed-futures-runtime-fixture',
      fidelity: 'ohlc-low.v1',
      runtime_version: 'futures-runtime-risk.v1',
      instrument_hash: canonicalHash(instrument),
    }
    const run = async (runId: string, batch: boolean) => {
      const dbPath = join(directory, `${runId}.sqlite`)
      const createStore = () => new FuturesStore(dbPath)
      const manifestData = {
        config_version: 'futures-strategies-config.v1',
        indicator_version: 'futures-closed-indicators.v1',
        strategy_ids: [
          'c25-pullback-perp-v1',
          'c26-reversion-perp-v1',
          'c27-breakout-perp-v1',
          'c28-adapter-perp-v1',
        ],
      }
      let store = createStore()
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
          schema_version: 'futures-runtime-binding.v4',
          runtime_config: runtimeConfig,
          instrument_spec: instrument,
          strategy_manifest: manifestData,
          strategy_config_hash: canonicalHash(manifestData),
        },
      })
      let runner = new FuturesCommandRunner(store)
      const apply = async (work: RuntimeWork) => {
        const market = work.input.payload.market_snapshot as Record<
          string,
          unknown
        >
        const request: FuturesWorkerRequest = {
          request_id: `request-${work.work_id}`,
          run_id: runId,
          work_id: work.work_id,
          expected_state_version: work.version,
          payload: {
            operation: 'futures_runtime.v3',
            runtime_config: runtimeConfig,
            instrument,
            market_snapshot: market,
          },
        }
        await runner.accept(request).result
        const projection = store.getRunProjection(runId)
        const events = store.exportRun(runId).events as Record<
          string,
          unknown
        >[]
        if (!batch && work.version === 0) {
          expect(
            (projection?.result as Record<string, unknown>).quantity_btc,
          ).toBe('0')
          const checkpoint = projection?.checkpoint as Record<string, unknown>
          const execution = checkpoint.execution_checkpoint as Record<
            string,
            unknown
          >
          const pending = Object.values(
            execution.orders as Record<string, Record<string, unknown>>,
          )[0]
          expect(pending?.eligible_at_ms).toBe(21_600_100)
        }
        if (!batch && work.version === 0) {
          await runner.close()
          store.close()
          store = createStore()
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
              schema_version: 'futures-runtime-binding.v4',
              runtime_config: runtimeConfig,
              instrument_spec: instrument,
              strategy_manifest: manifestData,
              strategy_config_hash: canonicalHash(manifestData),
            },
          })
          runner = new FuturesCommandRunner(store)
        }
        return {
          status: 'committed' as const,
          applied_state_version: Number(projection?.state_version),
          economic_projection: {
            ledger: projection?.result,
            events,
          },
        }
      }
      const options = { runId, manifest, apply }
      let result
      if (batch)
        result = await FuturesReplayDriver.replay({ ...options, inputs })
      else {
        const driver = new FuturesReplayDriver(options)
        for (const input of inputs) await driver.processEvent(input)
        result = driver.exportRun()
      }
      await runner.close()
      store.close()
      return result
    }

    const incremental = await run('incremental-run', false)
    const batch = await run('batch-run', true)
    expect(incremental.run_id).not.toBe(batch.run_id)
    expect(compareEconomicSemantics(incremental, batch)).toMatchObject({
      equal: true,
    })
    expect(incremental.semantic_hash).toBe(batch.semantic_hash)
    expect(incremental.economic_projection).not.toEqual(
      batch.economic_projection,
    )
    const emitted = JSON.stringify(incremental.economic_projection)
    expect(emitted).toContain('"price_usd_per_btc":"100001"')
    expect(emitted).toContain('"fee_usd":"0.49500495"')
    expect(emitted).toContain('"quantity_btc":"0.0099"')
  })
})
