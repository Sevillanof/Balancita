import { afterEach, describe, expect, it, vi } from 'vitest'
import { createReplayScheduler } from './offline-futures-scheduler.mjs'

describe('offline replay scheduler', () => {
  afterEach(() => vi.useRealTimers())

  it('preserves source order and schedules against monotonic receive offsets', () => {
    vi.useFakeTimers()
    const delivered = []
    const rows = [
      { received_at: 900 },
      { received_at: 925 },
      { received_at: 1200 },
    ]
    const scheduler = createReplayScheduler({
      rows,
      now: () => performance.now(),
      deliver: (row, timing) => delivered.push({ row, timing }),
    })

    vi.advanceTimersByTime(0)
    expect(delivered.map(({ row }) => row.received_at)).toEqual([900])
    vi.advanceTimersByTime(25)
    expect(delivered.map(({ row }) => row.received_at)).toEqual([900, 925])
    vi.advanceTimersByTime(275)
    expect(delivered.map(({ row }) => row.received_at)).toEqual([
      900, 925, 1200,
    ])
    expect(scheduler.complete).toBe(true)
    expect(delivered.map(({ timing }) => timing.due)).toEqual([0, 25, 300])
  })

  it.each([0.5, 1, 2])(
    'applies replay speed %s without reordering frames',
    async (speed) => {
      vi.useFakeTimers()
      const delivered = []
      const scheduler = createReplayScheduler({
        rows: [{ received_at: 100 }, { received_at: 120 }],
        speed,
        now: () => performance.now(),
        deliver: (row) => delivered.push(row.received_at),
      })
      await vi.advanceTimersByTimeAsync(20 / speed - 1)
      expect(delivered).toEqual([100])
      await vi.advanceTimersByTimeAsync(1)
      expect(delivered).toEqual([100, 120])
      expect(scheduler.complete).toBe(true)
    },
  )

  it('does not wait for a consumer and emits every frame on its deadline', async () => {
    vi.useFakeTimers()
    const delivered = []
    const scheduler = createReplayScheduler({
      rows: [{ received_at: 0 }, { received_at: 10 }, { received_at: 20 }],
      now: () => performance.now(),
      deliver: (row) => {
        delivered.push(row.received_at)
        return new Promise(() => {})
      },
    })
    await vi.advanceTimersByTimeAsync(20)
    expect(delivered).toEqual([0, 10, 20])
    expect(scheduler.processed).toBe(3)
  })
})
