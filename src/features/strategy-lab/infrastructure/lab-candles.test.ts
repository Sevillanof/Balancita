import { describe, expect, it, vi } from 'vitest'
import { loadLabCandles } from './lab-candles.ts'

const bootstrap = (count: number) => ({
  terminal_market: {
    candles: Array.from({ length: count }, (_, index) => ({
      time_ms: 1_700_000_000_000 + index * 60_000,
      open: 1,
      high: 2,
      low: 1,
      close: 2,
      volume_btc: 3,
      closed: true,
    })),
  },
})

describe('loadLabCandles', () => {
  it('reads the live gateway only', async () => {
    const load = vi.fn().mockResolvedValue(bootstrap(3))
    const result = await loadLabCandles(load)
    expect(load).toHaveBeenCalledTimes(1)
    expect(load).toHaveBeenCalledWith('/api-live')
    expect(result.source).toBe('live')
    expect(result.candles).toHaveLength(3)
  })

  it('never falls back to MOCK or invented candles', async () => {
    const load = vi.fn().mockRejectedValue(new Error('502'))
    await expect(loadLabCandles(load)).rejects.toThrow('502')
    expect(load).toHaveBeenCalledTimes(1)
    const empty = vi.fn().mockResolvedValue(bootstrap(0))
    await expect(loadLabCandles(empty)).rejects.toThrow(
      /sin velas|no devolvió/i,
    )
    expect(empty).toHaveBeenCalledTimes(1)
  })
})
