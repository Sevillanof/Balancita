import { describe, expect, it } from 'vitest'
import {
  nativeTradeTimeMs,
  pythonExecutionTimeMs,
} from './replay-run-contract.ts'

const window = { start_time: 1_700_000_000_000, end_time: 1_700_000_120_000 }
// Synthetic buy-fill values from fast-replay-execution-trace.json.
const fixtureFill = {
  side: 'buy',
  time: window.start_time,
  price: 100.05,
  qty: 0.29747031246281624,
  commission: 0.2380952380952381,
}

describe('stored replay execution timestamps', () => {
  it('accepts a native timestamp only with its verified serialized unit and meaning', () => {
    const run = {
      window,
      nativeTradeTimestampUnit: 'unix-milliseconds',
      nativeTradeTimestampMeaning: 'simulated-next-15m-candle-open',
    }
    expect(nativeTradeTimeMs(run, 1_700_000_060_000)).toBe(1_700_000_060_000)
    expect(nativeTradeTimeMs(run, 1_700_000_060)).toBeNull()
    expect(
      nativeTradeTimeMs(
        { ...run, nativeTradeTimestampUnit: 'unknown' },
        1_700_000_060_000,
      ),
    ).toBeNull()
    expect(
      nativeTradeTimeMs(
        { ...run, nativeTradeTimestampMeaning: undefined },
        1_700_000_060_000,
      ),
    ).toBeNull()
  })

  it.each([
    ['missing', undefined],
    ['NaN', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
    ['invalid date', 8_640_000_000_000_001],
    ['before the run', window.start_time - 1],
    ['after the run', window.end_time + 1],
  ])('suppresses native markers and time for %s values', (_name, timestamp) => {
    expect(
      nativeTradeTimeMs(
        {
          window,
          nativeTradeTimestampUnit: 'unix-milliseconds',
          nativeTradeTimestampMeaning: 'simulated-next-15m-candle-open',
        },
        timestamp,
      ),
    ).toBeNull()
  })

  it('accepts only a matching modeled-next-open Python audit within the run window', () => {
    const run = {
      window,
      pythonLedger: {
        ledger: { fills: [fixtureFill] },
        executionAudit: {
          fills: [
            {
              fillIndex: 0,
              fillSide: 'buy',
              timingStatus: 'modeled_next_open',
              executionAtMs: 1_700_000_060_000,
            },
          ],
        },
      },
    }
    expect(pythonExecutionTimeMs(run, 0)).toBe(1_700_000_060_000)
    expect(pythonExecutionTimeMs(run, -1)).toBeNull()
    expect(pythonExecutionTimeMs(run, 0.5)).toBeNull()
    expect(pythonExecutionTimeMs(run, 1)).toBeNull()
    expect(
      pythonExecutionTimeMs(
        {
          ...run,
          pythonLedger: {
            ...run.pythonLedger,
            executionAudit: {
              fills: [
                ...run.pythonLedger.executionAudit.fills,
                ...run.pythonLedger.executionAudit.fills,
              ],
            },
          },
        },
        0,
      ),
    ).toBeNull()
  })

  it.each([
    ['unmodeled', 'legacy_unknown', 1_700_000_060_000, 'buy'],
    ['null time', 'modeled_next_open', null, 'buy'],
    ['NaN time', 'modeled_next_open', Number.NaN, 'buy'],
    ['infinite time', 'modeled_next_open', Number.POSITIVE_INFINITY, 'buy'],
    ['unsafe time', 'modeled_next_open', Number.MAX_SAFE_INTEGER + 1, 'buy'],
    ['out-of-window time', 'modeled_next_open', window.end_time + 1, 'buy'],
    ['side mismatch', 'modeled_next_open', 1_700_000_060_000, 'sell'],
  ])(
    'suppresses Python execution time for %s audit entries',
    (_name, timingStatus, executionAtMs, fillSide) => {
      const run = {
        window,
        pythonLedger: {
          ledger: { fills: [fixtureFill] },
          executionAudit: {
            fills: [{ fillIndex: 0, fillSide, timingStatus, executionAtMs }],
          },
        },
      }
      expect(pythonExecutionTimeMs(run, 0)).toBeNull()
    },
  )
})
