import { describe, expect, it } from 'vitest'
import { retryWithBackoff } from './retry-backoff.ts'

describe('retry with backoff', () => {
  it('retries a failing query with growing waits and returns the first success', async () => {
    const waits: number[] = []
    let calls = 0
    const result = await retryWithBackoff(
      async () => {
        calls += 1
        if (calls < 4) throw new Error('network down after waking')
        return 'catalog'
      },
      { attempts: 5, sleep: async (ms) => void waits.push(ms) },
    )
    expect(result).toBe('catalog')
    expect(waits).toEqual([1_000, 2_000, 4_000])
  })

  it('caps the wait and gives up with the last error', async () => {
    const waits: number[] = []
    await expect(
      retryWithBackoff(
        async () => {
          throw new Error('still down')
        },
        {
          attempts: 6,
          maxDelayMs: 5_000,
          sleep: async (ms) => void waits.push(ms),
        },
      ),
    ).rejects.toThrow('still down')
    expect(waits).toEqual([1_000, 2_000, 4_000, 5_000, 5_000])
  })
})
