import { describe, expect, it } from 'vitest'
import { applyTerminalEvent } from './terminal-state.ts'

describe('terminal state event projection', () => {
  it('applies the nested durable command result version and tick analyses', () => {
    const first = applyTerminalEvent(
      { state_version: 0 },
      {
        schema_version: 1,
        event_id: 'command-result',
        stream_id: 'stream',
        run_id: 'run',
        seq: 1,
        type: 'command.result',
        instrument_id: 'kraken-futures:PF_XBTUSD',
        event_time: 1,
        published_at: 1,
        data: {
          result: {
            result: { applied_state_version: 1 },
          },
        },
      },
    )
    expect(first.state_version).toBe(1)

    const advanced = applyTerminalEvent(first, {
      schema_version: 1,
      event_id: 'scheduled-analysis',
      stream_id: 'stream',
      run_id: 'run',
      seq: 2,
      type: 'analysis.completed',
      instrument_id: 'kraken-futures:PF_XBTUSD',
      event_time: 101,
      published_at: 101,
      data: {
        analysis: { analysis_id: 'analysis', reason_codes: ['position_owned'] },
      },
    })
    expect(advanced.state_version).toBe(2)
    expect(advanced.analyses).toEqual([
      { analysis_id: 'analysis', reason_codes: ['position_owned'] },
    ])
  })
})
