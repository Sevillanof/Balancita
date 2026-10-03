import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FuturesCommandRunner } from './futures-command-runner.ts'
import { FuturesStore } from './futures-store.ts'
import { canonicalHash } from './futures-canonical.ts'
import type { FuturesWorkerRequest } from './futures-worker.ts'

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
    const store = new FuturesStore(join(directory, 'fixture.sqlite'))
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
    const runner = new FuturesCommandRunner(store)
    try {
      const command = request(
        runId,
        'c27-short-open',
        0,
        market(21_600_000, 'short', '100000', false),
      )
      await runner.accept(command).result
      const projection = store.getRunProjection(runId) as {
        result: { side: string; quantity_btc: string }
        checkpoint: {
          ledger_position: { side: string }
          owner_strategy_id: string
        }
      }
      expect(projection.result.side).toBe('short')
      expect(projection.result.quantity_btc).toBe('0.01')
      expect(projection.checkpoint.ledger_position.side).toBe('short')
      expect(projection.checkpoint.owner_strategy_id).toBe(
        'c27-breakout-perp-v1',
      )
      expect(store.verifyRun(runId)).toBe(true)
      const close = request(
        runId,
        'c27-short-close',
        1,
        market(21_660_000, 'flat', '100500', false),
        {
          type: 'paper.close',
          command_id: 'close-short',
        },
      )
      await runner.accept(close).result
      const closed = store.getRunProjection(runId) as {
        result: {
          side: string | null
          funding_complete: boolean
          net_complete: string | null
        }
        checkpoint: { ledger_position: unknown }
      }
      expect(closed.result.side).toBeNull()
      expect(closed.result.funding_complete).toBe(false)
      expect(closed.result.net_complete).toBeNull()
      expect(closed.checkpoint.ledger_position).toBeNull()
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
