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

function pythonMarket(decisionTime: number, breakout: 'long' | 'flat') {
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
