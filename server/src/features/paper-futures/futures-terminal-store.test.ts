import { describe, expect, it } from 'vitest'
import { projectTerminalState } from './futures-store.ts'

describe('terminal account snapshot projection', () => {
  it('subtracts positive fees and signed funding while preserving incomplete net', () => {
    const projection = {
      state_version: 5,
      result: { equity_usd: '9999.21' },
      runtime_output: { orders: [], fills: [] },
      checkpoint: {
        cash_usd: '9999.21',
        funding_paid: '-0.1',
        fees_usd: '0.5',
        realized_gross_usd: '-0.29',
        funding_complete: true,
        ledger_position: null,
        ledger_events: [],
      },
    }

    const complete = projectTerminalState(
      projection,
      'snapshot-regression-run',
      [],
      '10000',
    )
    expect(complete.account).toMatchObject({
      realized_gross_usd: '-0.29',
      fees_usd: '0.5',
      funding_paid_usd: '-0.1',
      funding_complete: true,
      net_usd: '-0.69',
    })

    const incomplete = projectTerminalState(
      {
        ...projection,
        checkpoint: { ...projection.checkpoint, funding_complete: false },
      },
      'snapshot-regression-run',
      [],
      '10000',
    )
    expect(incomplete.account).toMatchObject({
      funding_complete: false,
      net_usd: null,
    })
  })
})
