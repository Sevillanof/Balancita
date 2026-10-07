import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTerminalBatcher } from './terminal-batch.ts'
import { applyTerminalEvents } from './terminal-state.ts'
import type { TerminalEnvelope } from './terminal-stream-client.ts'

const event = (
  seq: number,
  type = 'market.updated',
  data: Record<string, unknown> = {},
): TerminalEnvelope => ({
  schema_version: 1,
  event_id: `e${seq}`,
  stream_id: 's',
  run_id: 'r',
  seq,
  type,
  instrument_id: 'PF_XBTUSD',
  event_time: seq,
  published_at: seq,
  data,
})

describe('createTerminalBatcher', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('shows the first tick at once and folds the rest into one flush a second', () => {
    const flush = vi.fn()
    const batcher = createTerminalBatcher(flush, 1_000)
    batcher.push(event(1))
    expect(flush).toHaveBeenCalledTimes(1)
    for (let seq = 2; seq <= 40; seq += 1) {
      vi.advanceTimersByTime(50)
      batcher.push(event(seq))
    }
    // 39 ticks over ~2 s: the leading one plus about one flush a second.
    expect(flush.mock.calls.length).toBeLessThanOrEqual(3)
    vi.advanceTimersByTime(1_000)
    const seen = flush.mock.calls.flatMap(([events]) =>
      (events as TerminalEnvelope[]).map((item) => item.seq),
    )
    expect(seen).toEqual(Array.from({ length: 40 }, (_, index) => index + 1))
  })

  it('flushes non-price events immediately, after the ticks queued before them', () => {
    const flush = vi.fn()
    const batcher = createTerminalBatcher(flush, 1_000)
    batcher.push(event(1))
    batcher.push(event(2))
    batcher.push(event(3, 'order.updated'))
    expect(flush).toHaveBeenCalledTimes(2)
    expect(
      (flush.mock.calls[1]![0] as TerminalEnvelope[]).map((item) => item.seq),
    ).toEqual([2, 3])
  })

  it('drops queued ticks on reset and never flushes after dispose', () => {
    const flush = vi.fn()
    const batcher = createTerminalBatcher(flush, 1_000)
    batcher.push(event(1))
    batcher.push(event(2))
    batcher.reset()
    vi.advanceTimersByTime(2_000)
    expect(flush).toHaveBeenCalledTimes(1)
    batcher.push(event(3))
    batcher.push(event(4))
    batcher.dispose()
    vi.advanceTimersByTime(2_000)
    expect(flush).toHaveBeenCalledTimes(2)
  })

  it('yields the same state as applying the events one by one', () => {
    const ticks = Array.from({ length: 5 }, (_, index) =>
      event(index + 1, 'market.updated', {
        candle: {
          bucket_start_ms: 60_000,
          interval_ms: 60_000,
          known_at_ms: index,
          closed: false,
          open: '1',
          high: '2',
          low: '1',
          close: String(index + 1),
          volume_btc: '1',
        },
      }),
    )
    const batched = applyTerminalEvents(null, ticks)
    const stepwise = ticks.reduce<Record<string, unknown> | null>(
      (state, item) => applyTerminalEvents(state, [item]),
      null,
    )
    expect(batched).toEqual(stepwise)
  })
})
