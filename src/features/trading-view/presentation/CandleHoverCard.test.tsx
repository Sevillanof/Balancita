import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import CandleHoverCard from './CandleHoverCard.tsx'

const spot = { time: 0, x: 200, highY: 150, lowY: 220 }

function card(isoUtc: string) {
  render(
    <CandleHoverCard
      candle={{
        time: Date.parse(isoUtc) / 1000,
        open: 100,
        high: 102,
        low: 99,
        close: 101,
        volume: 5,
      }}
      spot={spot}
      previousClose={100}
      volumeMax={10}
      steps={null}
      entries={[]}
      plotWidth={600}
      onHold={() => undefined}
    />,
  )
  return screen.getByTestId('candle-hover-card')
}

describe('candle hover card', () => {
  it('shows the Madrid day and hour of the candle (winter, UTC+1), with no UTC label', () => {
    const text = card('2026-11-09T22:15:00Z').textContent
    expect(text).toContain('9 nov, 23:15')
    expect(text).not.toMatch(/UTC/)
  })

  it('shows summer time (UTC+2) and crosses midnight in Madrid', () => {
    expect(card('2026-07-14T22:15:00Z').textContent).toContain('15 jul, 00:15')
  })

  it('writes the candle at 01:00 UTC on the spring change as 03:00', () => {
    expect(card('2026-03-29T01:00:00Z').textContent).toContain('29 mar, 03:00')
  })
})
