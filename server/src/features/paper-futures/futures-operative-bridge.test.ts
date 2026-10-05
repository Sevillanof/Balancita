import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FuturesCommandRunner } from './futures-command-runner.ts'
import { FuturesStore } from './futures-store.ts'
import { canonicalHash } from './futures-canonical.ts'
import type {
  FuturesWorkerDiagnostic,
  FuturesWorkerRequest,
} from './futures-worker.ts'

const POLICY = 'futures-operative-checkpoint.v1'
const directories: string[] = []
const instrument = {
  instrument_id: 'kraken-futures:PF_XBTUSD',
  provider_symbol: 'PF_XBTUSD',
  quantity_step_btc: '0.0001',
  minimum_quantity_btc: '0.0001',
  price_tick_usd: '1',
}
const baseConfig = {
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

const admissionBody = {
  schema_version: 'futures-entry-admission.v1',
  evaluation_interval_ms: 5000,
} as const
const admissionPolicy = { ...admissionBody, hash: canonicalHash(admissionBody) }

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

function pythonMarket(
  decisionTime: number,
  options: { breakout: 'long' | 'short' | 'flat'; bookSize?: string },
) {
  const root = resolve(import.meta.dirname, '../../../../')
  const script = `import json\nfrom futures_runtime_fixtures import warmed_market\nprint(json.dumps(warmed_market(${decisionTime}, breakout=${JSON.stringify(options.breakout)}, book_size=${JSON.stringify(options.bookSize ?? '1')})))\n`
  const result = spawnSync('python3', ['-c', script], {
    cwd: root,
    env: { ...process.env, PYTHONPATH: `${root}/python:${root}/python/tests` },
    encoding: 'utf8',
  })
  if (result.status !== 0) throw new Error(result.stderr)
  return JSON.parse(result.stdout) as Record<string, unknown> & {
    events: Record<string, unknown>[]
  }
}

function setup(runId: string, optIn: boolean) {
  const directory = mkdtempSync(join(tmpdir(), 'futures-operative-bridge-'))
  directories.push(directory)
  const path = join(directory, 'futures.sqlite')
  const runtimeConfig = optIn
    ? { ...baseConfig, operative_checkpoint_policy_version: POLICY }
    : baseConfig
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
      version: baseConfig.cost_version,
      maker: baseConfig.maker_rate,
      taker: baseConfig.taker_rate,
    },
    runtime: {
      schema_version: 'futures-runtime-binding.v5',
      runtime_config: runtimeConfig,
      instrument_spec: instrument,
      strategy_manifest: strategies,
      strategy_config_hash: canonicalHash(strategies),
      admission_policy: admissionPolicy,
    },
  })
  const diagnostics: FuturesWorkerDiagnostic[] = []
  const runner = new FuturesCommandRunner(store, {
    workerObserver: (event) => diagnostics.push(event),
  })
  const request = (
    index: number,
    market: Record<string, unknown>,
  ): FuturesWorkerRequest => ({
    request_id: `request-${runId}-${index}`,
    run_id: runId,
    work_id: `work-${runId}-${index}`,
    expected_state_version: index,
    payload: {
      operation: 'futures_runtime.v3',
      runtime_config: runtimeConfig,
      instrument,
      market_snapshot: market,
    },
  })
  return { path, store, runner, diagnostics, request }
}

/** Distinct exact book identities per job, like a live feed. */
function cycleMarkets(base: number) {
  const open = pythonMarket(base, { breakout: 'long', bookSize: '0.005' })
  const fill = pythonMarket(base + 100, { breakout: 'flat', bookSize: '0.005' })
  const crossing = pythonMarket(base + 200, { breakout: 'flat' })
  const close = pythonMarket(base + 300, { breakout: 'flat' })
  const markets = [open, fill, crossing, close]
  markets.forEach((market, index) => {
    const book = market.events.find((event) => event.type === 'book_snapshot')!
    book.sequence = 1000 + index
  })
  return markets
}

function identityCounts(path: string, runId: string) {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    const count = (sql: string) =>
      Number((database.prepare(sql).get(runId) as { n: number }).n)
    return {
      history: count(
        'SELECT COUNT(*) AS n FROM futures_operative_identity_history WHERE run_id=?',
      ),
      work: count(
        'SELECT COUNT(*) AS n FROM futures_operative_identity_work WHERE run_id=?',
      ),
      signals: count(
        "SELECT COUNT(*) AS n FROM futures_operative_identity_current WHERE run_id=? AND kind='signal'",
      ),
    }
  } finally {
    database.close()
  }
}

describe('operative identity bridge (inactive: explicit opt-in only)', () => {
  it('commits compact checkpoints and exact identities atomically for an opted-in run', async () => {
    const runId = 'bridge-opted'
    const { path, store, runner, diagnostics, request } = setup(runId, true)
    const markets = cycleMarkets(21_600_000)
    const positions: string[] = []
    for (const [index, market] of markets.entries()) {
      if (index === 2) {
        const stop = Number(
          (
            store.getRunProjection(runId)?.runtime_output as {
              position: { stop_price_usd_per_btc: string }
            }
          )?.position?.stop_price_usd_per_btc ?? '0',
        )
        const ticker = market.events.find((event) => event.type === 'ticker')!
        ticker.mark_usd = String(stop > 0 ? stop - 1 : 99000)
        Object.assign(
          market.events.find((event) => event.type === 'book_snapshot')!,
          { valid: false, contiguous: false },
        )
      }
      await runner.accept(request(index, market)).result
      const counts = identityCounts(path, runId)
      expect(counts.work).toBe(index + 1)
      const checkpoint = store.getRunProjection(runId)?.checkpoint as Record<
        string,
        unknown
      >
      expect(checkpoint.operative_checkpoint_policy_version).toBe(POLICY)
      expect(checkpoint).toHaveProperty('execution_operative_checkpoint')
      expect(checkpoint).not.toHaveProperty('ledger_events')
      expect(store.verifyRun(runId)).toBe(true)
      const quantity = (
        store.getRunProjection(runId)?.result as { quantity_btc: string }
      ).quantity_btc
      positions.push(quantity)
    }
    // Entry fills, the stop crossing queues a reduce-only order, and the flat
    // account is restored from compact state plus exact identities alone.
    expect(positions[0]).toBe('0')
    expect(positions[1]).not.toBe('0')
    expect(positions[3]).toBe('0')
    const counts = identityCounts(path, runId)
    expect(counts.signals).toBeGreaterThanOrEqual(1)
    expect(counts.history).toBeGreaterThan(counts.signals)
    const queried = new Set(
      diagnostics
        .filter((event) => event.phase === 'identity_query_received')
        .map((event) => event.work_id),
    )
    expect(queried.size).toBeGreaterThanOrEqual(1)
    await runner.close()
    store.close()
  }, 120_000)

  it('rejects a duplicate signal identity and leaves no partial commit', async () => {
    const runId = 'bridge-duplicate'
    const { path, store, runner, request } = setup(runId, true)
    const [open] = cycleMarkets(21_600_000)
    const original = store.applyResult.bind(store)
    const spy = vi
      .spyOn(store, 'applyResult')
      .mockImplementation((value, ...rest) => {
        const envelope = value as {
          runtime_identity_updates: { execution: Record<string, unknown>[] }
        }
        const signal = envelope.runtime_identity_updates.execution.find(
          (update) => update.kind === 'signal',
        )!
        envelope.runtime_identity_updates.execution.push({ ...signal })
        return original(value, ...rest)
      })
    await expect(runner.accept(request(0, open!)).result).rejects.toThrow(
      /duplicate|conflict/i,
    )
    spy.mockRestore()
    expect(store.getRunProjection(runId)?.state_version).toBe(0)
    expect(identityCounts(path, runId)).toEqual({
      history: 0,
      work: 0,
      signals: 0,
    })
    expect(store.verifyRun(runId)).toBe(true)
    await runner.close()
    store.close()
  }, 120_000)

  it('fails closed with no partial commit when identity lookup is unavailable', async () => {
    const runId = 'bridge-unavailable'
    const { path, store, runner, request } = setup(runId, true)
    const [open] = cycleMarkets(21_600_000)
    const lookup = vi
      .spyOn(store, 'lookupOperativeIdentities')
      .mockImplementation(() => {
        throw new Error('identity store unavailable')
      })
    await expect(runner.accept(request(0, open!)).result).rejects.toThrow()
    expect(lookup).toHaveBeenCalled()
    expect(store.getRunProjection(runId)?.state_version).toBe(0)
    expect(identityCounts(path, runId).history).toBe(0)
    expect(store.verifyRun(runId)).toBe(true)
    await runner.close()
    store.close()
  }, 120_000)

  it('keeps a non-opted run byte-identical: legacy checkpoint, no identity rows or RPC', async () => {
    const runId = 'bridge-legacy'
    const { path, store, runner, diagnostics, request } = setup(runId, false)
    const markets = cycleMarkets(21_600_000)
    for (const [index, market] of markets.slice(0, 2).entries())
      await runner.accept(request(index, market)).result
    const checkpoint = store.getRunProjection(runId)?.checkpoint as Record<
      string,
      unknown
    >
    expect(checkpoint).toHaveProperty('ledger_events')
    expect(checkpoint).not.toHaveProperty('execution_operative_checkpoint')
    expect(identityCounts(path, runId)).toEqual({
      history: 0,
      work: 0,
      signals: 0,
    })
    expect(
      diagnostics.some((event) => event.phase === 'identity_query_received'),
    ).toBe(false)
    expect(store.verifyRun(runId)).toBe(true)
    await runner.close()
    store.close()
  }, 120_000)

  it('public verification covers identity rows: tampered history fails closed', async () => {
    const runId = 'bridge-tamper'
    const { path, store, runner, request } = setup(runId, true)
    const [open] = cycleMarkets(21_600_000)
    await runner.accept(request(0, open!)).result
    expect(store.verifyRun(runId)).toBe(true)
    const database = new DatabaseSync(path)
    try {
      database.exec('DROP TRIGGER futures_operative_identity_history_no_update')
      database
        .prepare(
          "UPDATE futures_operative_identity_history SET value_json='true' WHERE kind='signal' AND run_id=?",
        )
        .run(runId)
      // A forged exact-identity value must not pass the public verifier.
      database
        .prepare(
          "UPDATE futures_operative_identity_history SET provenance='forged' WHERE run_id=? AND seq=(SELECT MIN(seq) FROM futures_operative_identity_history)",
        )
        .run(runId)
    } finally {
      database.close()
    }
    expect(store.verifyRun(runId)).toBe(false)
    await runner.close()
    store.close()
  }, 120_000)
})
