import type { FastReplayCandle } from './fast-replay-engine.ts'

export function makeCandle(index: number): FastReplayCandle {
  const timestamp = 1_700_000_100 + index * 60
  const close = 20_000 + index
  return {
    timestamp,
    open: close - 1,
    high: close + 2,
    low: close - 2,
    close,
    volume: 10,
  }
}
