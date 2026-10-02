import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FuturesStore } from './futures-store.ts'

const directories: string[] = []
type RuntimeCheckpoint = Record<string, unknown> & {
  ledger_position: (Record<string, unknown> & { qty: string }) | null
  runtime_config: Record<string, unknown>
  ledger_events: Record<string, unknown>[]
}
type RuntimeOutput = Record<string, unknown> & {
  ledger: Record<string, unknown>
  position: Record<string, unknown>
  orders: Record<string, unknown>[]
  fills: Record<string, unknown>[]
}
type RuntimeFixture = {
  opened: RuntimeOutput
  open_checkpoint: RuntimeCheckpoint
  closed: RuntimeOutput
  closed_checkpoint: RuntimeCheckpoint
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

function actualRuntimeCycles(
  side: 'long' | 'short' = 'long',
  fundingKnown = true,
): RuntimeFixture {
  const root = resolve(import.meta.dirname, '../../../../')
  const pythonFundingKnown = fundingKnown ? 'True' : 'False'
  const script = String.raw`
import json
from balancita_engine.futures_runtime import FuturesRuntime
from futures_runtime_fixtures import CONFIG, INSTRUMENT, warmed_market, add_known_funding
engine = FuturesRuntime(run_id='runtime-store-run', config=CONFIG, instrument=INSTRUMENT)
first_market = warmed_market(21600000, breakout=${JSON.stringify(side)})
if ${pythonFundingKnown}: first_market = add_known_funding(first_market, rate='0')
opened = engine.process(first_market)
open_checkpoint = engine.checkpoint()
engine = FuturesRuntime(run_id='runtime-store-run', config=CONFIG, instrument=INSTRUMENT, checkpoint=open_checkpoint)
second_market = warmed_market(21660000, base_price='100500')
if ${pythonFundingKnown}: second_market = add_known_funding(second_market, rate='0')
closed = engine.process(second_market, control={'type':'paper.close','command_id':'close-1'})
print(json.dumps({'opened': opened, 'open_checkpoint': open_checkpoint, 'closed': closed, 'closed_checkpoint': engine.checkpoint()}))
`
  const result = spawnSync('python3', ['-c', script], {
    cwd: root,
    env: { ...process.env, PYTHONPATH: `${root}/python:${root}/python/tests` },
    encoding: 'utf8',
  })
  if (result.status !== 0) throw new Error(result.stderr)
  return JSON.parse(result.stdout) as RuntimeFixture
}

function createRuntimeRun(store: FuturesStore): void {
  const runtimeConfig = {
    version: 'futures-runtime-lab.v1',
    initial_cash_usd: '10000',
    max_notional_usd: '1000',
    max_exposure_multiple: '1',
    risk_fraction: '0.001',
    execution_latency_ms: 0,
    max_book_age_ms: 3000,
    max_spread_bps: '5',
    cost_version: 'kraken-futures-eea-btcusd-base.v1',
    maker_rate: '0.0002',
    taker_rate: '0.0005',
  }
  store.createRun({
    runId: 'runtime-store-run',
    config: {
      ledger_version: 'linear-usd-ledger.v1',
      decimal_precision: 50,
      leverage: '1',
    },
    seed: { cash_usd: '10000' },
    instrument: { instrument_id: 'kraken-futures:PF_XBTUSD' },
    costs: {
      version: 'kraken-futures-eea-btcusd-base.v1',
      maker: '0.0002',
      taker: '0.0005',
    },
    runtime: {
      schema_version: 'futures-runtime-binding.v1',
      runtime_config: runtimeConfig,
      instrument_spec: {
        instrument_id: 'kraken-futures:PF_XBTUSD',
        provider_symbol: 'PF_XBTUSD',
        quantity_step_btc: '0.0001',
        minimum_quantity_btc: '0.0001',
        price_tick_usd: '1',
      },
    },
  })
}

function newStore(): FuturesStore {
  const directory = mkdtempSync(join(tmpdir(), 'futures-runtime-store-'))
  directories.push(directory)
  return new FuturesStore(join(directory, 'store.sqlite'))
}

function runtimeEvents(
  output: RuntimeOutput,
  workId: string,
): Record<string, unknown>[] {
  const ledger = output.ledger
  const eventTime = (
    output.orders[output.orders.length - 1] as Record<string, unknown>
  ).eligible_at_ms as number
  const identity = {
    event_version: 1,
    run_id: 'runtime-store-run',
    work_id: workId,
    instrument_id: 'kraken-futures:PF_XBTUSD',
    cost_version: 'kraken-futures-eea-btcusd-base.v1',
  }
  const fills = (output.fills as Record<string, unknown>[]).map((fill) => ({
    ...identity,
    id: `${workId}:event:${String(fill.fill_id)}`,
    fill_id: fill.fill_id,
    type: 'fill',
    side: fill.side,
    quantity_btc: fill.quantity_btc,
    price_usd_per_btc: fill.price_usd_per_btc,
    fee_usd: fill.fee_usd,
    liquidity: fill.liquidity,
  }))
  const position = output.position
  return [
    ...fills,
    {
      ...identity,
      id: `${workId}:position`,
      type: 'position',
      event_time_ms: eventTime,
      side: position.side,
      quantity_btc: position.quantity_btc,
    },
    {
      ...identity,
      id: `${workId}:account`,
      type: 'account',
      event_time_ms: eventTime,
      equity_usd: ledger.equity_usd,
      available_margin_usd: ledger.available_margin_usd,
      reserved_margin_usd: ledger.reserved_margin_usd,
      fees_usd: ledger.fees_usd,
      funding_paid: ledger.funding_paid,
    },
  ]
}

describe('versioned C27 runtime persistence', () => {
  it('persists actual long-open output and checkpoint, closes after restore, and verifies after reopen', () => {
    const cycles = actualRuntimeCycles()
    const store = newStore()
    createRuntimeRun(store)
    expect(store.getRuntimeBinding('runtime-store-run')?.schema_version).toBe(
      'futures-runtime-binding.v1',
    )
    store.recordWork({
      workId: 'runtime-open',
      runId: 'runtime-store-run',
      cycleKey: 'cycle-open',
      expectedVersion: 0,
      snapshot: { cycle: 0 },
    })
    const opened = cycles.opened
    expect(opened.ledger.side).toBe('long')
    expect(opened.ledger.quantity_btc).toBe('0.0099')
    const openResult = {
      schema_version: 'futures-runtime-work.v1',
      protocol_version: 1,
      run_id: 'runtime-store-run',
      work_id: 'runtime-open',
      applied_state_version: 1,
      result: opened.ledger,
      events: runtimeEvents(opened, 'runtime-open'),
      runtime_output: opened,
      runtime_checkpoint: cycles.open_checkpoint,
    }
    const receipt = store.applyResult(openResult)
    expect(receipt.status).toBe('committed')
    expect(store.getRunProjection('runtime-store-run')).toMatchObject({
      checkpoint: cycles.open_checkpoint,
    })
    store.recordWork({
      workId: 'runtime-close',
      runId: 'runtime-store-run',
      cycleKey: 'cycle-close',
      expectedVersion: 1,
      snapshot: { cycle: 1 },
    })
    const closeResult = {
      ...openResult,
      work_id: 'runtime-close',
      applied_state_version: 2,
      result: cycles.closed.ledger,
      runtime_output: cycles.closed,
      runtime_checkpoint: cycles.closed_checkpoint,
      events: runtimeEvents(cycles.closed, 'runtime-close'),
    }
    expect(cycles.closed.position.quantity_btc).toBe('0')
    expect(cycles.closed.ledger.realized_net_complete).toBe('-0.99990495')
    expect(() => store.applyResult(closeResult, 'before-commit')).toThrow(
      'Injected pre-commit failure.',
    )
    expect(store.getRunProjection('runtime-store-run')?.state_version).toBe(1)
    const closeReceipt = store.applyResult(closeResult)
    expect(closeReceipt.status).toBe('committed')
    expect(store.applyResult(closeResult)).toEqual(closeReceipt)
    expect(store.verifyRun('runtime-store-run')).toBe(true)
    store.close()
    const auditDb = new DatabaseSync(join(directories[0]!, 'store.sqlite'))
    expect(
      auditDb
        .prepare(
          "SELECT COUNT(*) AS count FROM paper_futures_ledger WHERE json_extract(payload_json,'$.type') IN ('open','close')",
        )
        .get(),
    ).toEqual({ count: 3 })
    auditDb.close()
    const reopened = new FuturesStore(join(directories[0]!, 'store.sqlite'))
    expect(reopened.verifyRun('runtime-store-run')).toBe(true)
    expect(reopened.getRunProjection('runtime-store-run')).toMatchObject({
      checkpoint: cycles.closed_checkpoint,
    })
    reopened.close()
    const tamper = new DatabaseSync(join(directories[0]!, 'store.sqlite'))
    const projection = JSON.parse(
      (
        tamper
          .prepare(
            'SELECT state_json FROM paper_futures_projections WHERE run_id=?',
          )
          .get('runtime-store-run') as { state_json: string }
      ).state_json,
    )
    projection.checkpoint.signal_keys = []
    tamper
      .prepare(
        'UPDATE paper_futures_projections SET state_json=? WHERE run_id=?',
      )
      .run(JSON.stringify(projection), 'runtime-store-run')
    tamper.close()
    const tampered = new FuturesStore(join(directories[0]!, 'store.sqlite'))
    expect(tampered.verifyRun('runtime-store-run')).toBe(false)
    tampered.close()
  })

  it('accepts an actual short-open checkpoint without changing its side or quantity', () => {
    const cycles = actualRuntimeCycles('short')
    const store = newStore()
    createRuntimeRun(store)
    store.recordWork({
      workId: 'runtime-short',
      runId: 'runtime-store-run',
      cycleKey: 'cycle-short',
      expectedVersion: 0,
      snapshot: { cycle: 'short' },
    })
    const output = cycles.opened
    const receipt = store.applyResult({
      schema_version: 'futures-runtime-work.v1',
      protocol_version: 1,
      run_id: 'runtime-store-run',
      work_id: 'runtime-short',
      applied_state_version: 1,
      result: output.ledger,
      events: runtimeEvents(output, 'runtime-short'),
      runtime_output: output,
      runtime_checkpoint: cycles.open_checkpoint,
    })
    expect(receipt.status).toBe('committed')
    expect(output.ledger.quantity_btc).toBe('0.01')
    expect(output.ledger.side).toBe('short')
    expect(
      (
        store.getRunProjection('runtime-store-run')?.result as Record<
          string,
          unknown
        >
      ).side,
    ).toBe('short')
    store.recordWork({
      workId: 'runtime-short-close',
      runId: 'runtime-store-run',
      cycleKey: 'cycle-short-close',
      expectedVersion: 1,
      snapshot: { cycle: 'short-close' },
    })
    expect(
      store.applyResult({
        schema_version: 'futures-runtime-work.v1',
        protocol_version: 1,
        run_id: 'runtime-store-run',
        work_id: 'runtime-short-close',
        applied_state_version: 2,
        result: cycles.closed.ledger,
        events: runtimeEvents(cycles.closed, 'runtime-short-close'),
        runtime_output: cycles.closed,
        runtime_checkpoint: cycles.closed_checkpoint,
      }).status,
    ).toBe('committed')
    expect(
      (
        store.getRunProjection('runtime-store-run')?.result as Record<
          string,
          unknown
        >
      ).side,
    ).toBeNull()
    expect(store.verifyRun('runtime-store-run')).toBe(true)
    store.close()
  })

  it('rejects runtime drift and malformed checkpoint accounting before advancing state', () => {
    const cycles = actualRuntimeCycles()
    const store = newStore()
    createRuntimeRun(store)
    store.recordWork({
      workId: 'runtime-invalid',
      runId: 'runtime-store-run',
      cycleKey: 'cycle-invalid',
      expectedVersion: 0,
      snapshot: { cycle: 'invalid' },
    })
    const result = {
      schema_version: 'futures-runtime-work.v1',
      protocol_version: 1,
      run_id: 'runtime-store-run',
      work_id: 'runtime-invalid',
      applied_state_version: 1,
      result: cycles.opened.ledger,
      events: runtimeEvents(cycles.opened, 'runtime-invalid'),
      runtime_output: cycles.opened,
      runtime_checkpoint: structuredClone(cycles.open_checkpoint),
    }
    const checkpointPosition = result.runtime_checkpoint.ledger_position
    if (!checkpointPosition)
      throw new Error('Expected the actual runtime fixture to be open.')
    checkpointPosition.qty = '-0.0099'
    expect(() => store.applyResult(result)).toThrow(/quantity/i)
    expect(store.getRunProjection('runtime-store-run')?.state_version).toBe(0)
    checkpointPosition.qty = '0.0099'
    result.runtime_checkpoint.runtime_config.initial_cash_usd = '9000'
    expect(() => store.applyResult(result)).toThrow(/configuration/i)
    expect(store.getRunProjection('runtime-store-run')?.state_version).toBe(0)
    result.runtime_checkpoint.runtime_config.initial_cash_usd = '10000'
    const audit = (result.result.events as Record<string, unknown>[])[0]
    audit.type = 'unrecognized'
    result.runtime_checkpoint.ledger_events[0] = audit
    expect(() => store.applyResult(result)).toThrow(
      'Unsupported ledger audit event type.',
    )
    expect(store.getRunProjection('runtime-store-run')?.state_version).toBe(0)
    expect(store.verifyRun('runtime-store-run')).toBe(true)
    store.close()
  })

  it('preserves unknown-funding net as incomplete after restoring and closing', () => {
    const cycles = actualRuntimeCycles('long', false)
    expect(cycles.opened.ledger.net_complete).toBeNull()
    expect(cycles.closed.ledger.funding_complete).toBe(false)
    expect(cycles.closed.ledger.net_complete).toBeNull()
    expect(cycles.closed.ledger.realized_net_complete).toBeNull()
    const store = newStore()
    createRuntimeRun(store)
    store.recordWork({
      workId: 'unknown-open',
      runId: 'runtime-store-run',
      cycleKey: 'unknown-open',
      expectedVersion: 0,
      snapshot: {},
    })
    expect(
      store.applyResult({
        schema_version: 'futures-runtime-work.v1',
        protocol_version: 1,
        run_id: 'runtime-store-run',
        work_id: 'unknown-open',
        applied_state_version: 1,
        result: cycles.opened.ledger,
        events: runtimeEvents(cycles.opened, 'unknown-open'),
        runtime_output: cycles.opened,
        runtime_checkpoint: cycles.open_checkpoint,
      }).status,
    ).toBe('committed')
    store.recordWork({
      workId: 'unknown-close',
      runId: 'runtime-store-run',
      cycleKey: 'unknown-close',
      expectedVersion: 1,
      snapshot: {},
    })
    expect(
      store.applyResult({
        schema_version: 'futures-runtime-work.v1',
        protocol_version: 1,
        run_id: 'runtime-store-run',
        work_id: 'unknown-close',
        applied_state_version: 2,
        result: cycles.closed.ledger,
        events: runtimeEvents(cycles.closed, 'unknown-close'),
        runtime_output: cycles.closed,
        runtime_checkpoint: cycles.closed_checkpoint,
      }).status,
    ).toBe('committed')
    expect(store.verifyRun('runtime-store-run')).toBe(true)
    store.close()
  })
})
