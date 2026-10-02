import { describe, expect, it } from 'vitest'
import { FuturesWorker } from './futures-worker.ts'

describe('FuturesWorker', () => {
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
