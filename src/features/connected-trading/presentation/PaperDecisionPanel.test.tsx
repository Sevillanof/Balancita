import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import PaperDecisionPanel from './PaperDecisionPanel.tsx'
import type { PaperDecisionEvent } from '../infrastructure/connected-trading-provider.ts'

const decision: PaperDecisionEvent = {
  id: 'session-1:strategy:1000',
  instrumentId: 'BTC-EUR',
  eventTime: 1_700_000_000_000,
  receivedAt: 1_700_000_000_010,
  strategyId: 'micro-trend-pullback',
  strategyVersion: 'strategy-rule.v2',
  direction: 'long',
  outcome: 'gate-rejected',
  reasonCode: 'entry_gate_rejected',
  sessionId: 'runtime-a',
  reason: null,
  conditions: [
    {
      code: 'entry_gate_distance',
      value: 0.004,
      operator: '>=',
      threshold: 0.006,
      passed: false,
    },
  ],
}

describe('PaperDecisionPanel', () => {
  it('shows evaluated gate facts and selects the same backend decision ID', () => {
    const onSelect = vi.fn()
    render(
      <PaperDecisionPanel
        decisions={[decision]}
        selectedId={null}
        onSelect={onSelect}
      />,
    )

    expect(screen.getByText('Gate de entrada rechazado')).toBeTruthy()
    expect(screen.getByText(/0,004.*≥.*0,006/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button'))
    expect(onSelect).toHaveBeenCalledWith(decision)
  })

  it('shows an explicit empty state instead of synthetic decisions', () => {
    render(
      <PaperDecisionPanel
        decisions={[]}
        selectedId={null}
        onSelect={vi.fn()}
      />,
    )
    expect(screen.getByRole('status').textContent).toBe(
      'No hay decisiones registradas.',
    )
  })

  it('shows unavailable rationale for legacy records without diagnostics', () => {
    render(
      <PaperDecisionPanel
        decisions={[{ ...decision, reasonCode: null, conditions: [] }]}
        selectedId={null}
        onSelect={vi.fn()}
      />,
    )
    expect(screen.getAllByText('No disponible')).toHaveLength(2)
  })
})
