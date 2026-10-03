import { describe, expect, it } from 'vitest'
import {
  FuturesWorker,
  validateFuturesWorkerRequest,
} from './futures-worker.ts'

describe('FuturesWorker', () => {
  it('rejects untyped funding provenance before worker submission', () => {
    const request = normalizedFundingRequest()
    request.payload.market_snapshot.events[0]!.observation.unit = 'unknown'
    expect(() => validateFuturesWorkerRequest(request)).toThrow(/payload/)
  })

  it('accepts explicitly unresolved funding without inventing an interval', () => {
    const request = normalizedFundingRequest()
    const observation = request.payload.market_snapshot.events[0]!
      .observation as unknown as Record<string, unknown>
    observation.unit = 'provider-unresolved'
    observation.effective_start_ms = null
    observation.effective_end_ms = null
    expect(() => validateFuturesWorkerRequest(request)).not.toThrow()
  })

  it('uses one persistent Python process for ordered ledger requests', async () => {
    const committed: string[] = []
    const worker = new FuturesWorker({
      commitResult: async (result) => {
        committed.push(result.work_id)
        return {
          status: 'committed',
          applied_state_version: result.applied_state_version,
          result_hash: 'a'.repeat(64),
        }
      },
    })
    try {
      const first = worker.submit(request('request-1', 'work-1', 'long'))
      const pid = worker.pid
      const second = worker.submit(request('request-2', 'work-2', 'short'))
      const [long, short] = await Promise.all([first, second])

      expect(pid).toBeDefined()
      expect(worker.pid).toBe(pid)
      expect(long.result.realized_net_complete).toBe('0.09895')
      expect(short.result.realized_net_complete).toBe('0.09905')
      expect(long.events.map((event) => event.type)).toEqual(['open', 'close'])
      expect(short.events.map((event) => event.type)).toEqual(['open', 'close'])
      expect(committed).toEqual(['work-1', 'work-2'])
    } finally {
      await worker.close()
    }
    await expect(
      worker.submit(request('after-close', 'work-3', 'long')),
    ).rejects.toThrow(/closed/)
  })

  it('rejects invalid identity and state version before writing to the process', async () => {
    const worker = new FuturesWorker({
      commitResult: async (result) => ({
        status: 'committed',
        applied_state_version: result.applied_state_version,
        result_hash: 'b'.repeat(64),
      }),
    })
    expect(() =>
      worker.submit({
        ...request('bad', 'work-bad', 'long'),
        expected_state_version: -1,
      }),
    ).toThrow(/version/)
    await worker.close()
  })

  it('enforces a fixed bounded queue instead of silently dropping accepted work', async () => {
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const worker = new FuturesWorker({
      timeoutMs: 30_000,
      commitResult: async (result) => {
        await barrier
        return {
          status: 'committed',
          applied_state_version: result.applied_state_version,
          result_hash: 'c'.repeat(64),
        }
      },
    })
    const accepted = Array.from({ length: 32 }, (_, index) =>
      worker.submit(
        request(`bounded-${index}`, `bounded-work-${index}`, 'long'),
      ),
    )
    await expect(
      worker.submit(
        request('bounded-overflow', 'bounded-work-overflow', 'long'),
      ),
    ).rejects.toThrow(/queue is full/)
    release()
    await Promise.all(accepted)
    await worker.close()
  })
})

function normalizedFundingRequest() {
  const instrument = {
    instrument_id: 'kraken-futures:PF_XBTUSD',
    provider_symbol: 'PF_XBTUSD',
    quantity_step_btc: '0.0001',
    minimum_quantity_btc: '0.0001',
    price_tick_usd: '1',
  }
  return {
    request_id: 'funding-request',
    run_id: 'funding-run',
    work_id: 'funding-work',
    expected_state_version: 0,
    payload: {
      operation: 'futures_runtime.v3' as const,
      runtime_config: {
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
      },
      instrument,
      market_snapshot: {
        mode: 'mock',
        instrument,
        decision_time_ms: 1000,
        cutoff_received_at_ms: 1000,
        events: [
          {
            type: 'funding_observation',
            received_at_ms: 0,
            known_at_ms: 0,
            observation: {
              source: 'fixture',
              provider: 'kraken',
              product: 'PF_XBTUSD',
              field: 'funding_rate',
              raw_rate: '0.0001',
              unit: 'usd_per_btc_per_hour',
              effective_start_ms: 0,
              effective_end_ms: 3_600_000,
              known_at_ms: 0,
              received_seq: 1,
              observation_id: 'funding-1',
              sha256: 'a'.repeat(64),
              semantic_version: 'kraken-funding-normalization.v1',
              predicted: false,
            },
          },
        ],
      },
    },
  }
}

function request(requestId: string, workId: string, side: 'long' | 'short') {
  return {
    request_id: requestId,
    run_id: 'run-fixture',
    work_id: workId,
    expected_state_version: 0,
    payload: {
      operation: 'round_trip' as const,
      cash_usd: '1000',
      side,
      quantity_btc: '0.01',
      entry_price: '100',
      exit_price: side === 'long' ? '110' : '90',
    },
  }
}
