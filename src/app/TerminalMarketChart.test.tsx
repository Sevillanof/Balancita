import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import TerminalMarketChart from './TerminalMarketChart.tsx'

describe('TerminalMarketChart', () => {
  it('shows no candles for a market that is not futures-terminal-market.v1', () => {
    render(
      <TerminalMarketChart
        market={{
          schema_version: 'mock-terminal-market.v1',
          as_of_ms: 120_000,
          interval_ms: 60_000,
          candles: [
            {
              time_ms: 60_000,
              open: '100',
              high: '101',
              low: '99',
              close: '100',
              volume_btc: '1',
              closed: true,
            },
          ],
        }}
        mode="paper_live"
        analyses={[]}
        selectedId=""
        onSelect={() => undefined}
        apiBase="/api-live"
        ticker={null}
        position={{}}
        orders={[]}
      />,
    )
    expect(
      screen.getByText('El snapshot no contiene velas verificables.'),
    ).toBeInTheDocument()
  })
})
