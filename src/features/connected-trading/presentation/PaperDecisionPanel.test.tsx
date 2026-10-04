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
  it('shows newest events first and keeps the selected detail on that event', () => {
    const older = { ...decision, id: 'older', eventTime: 1_700_000_000_000 }
    const newest = {
      ...decision,
      id: 'newest',
      eventTime: 1_700_000_060_000,
      receivedAt: 1_700_000_061_000,
      reason: 'Recent backend rationale',
    }
    render(
      <PaperDecisionPanel
        decisions={[newest, older]}
        selectedId="older"
        onSelect={vi.fn()}
      />,
    )

    const rows = screen.getAllByRole('button')
    expect(rows[0]).toHaveTextContent('Recent backend rationale')
    expect(rows[1]).toHaveTextContent('micro-trend-pullback')
    expect(screen.getByText(/Sesión:/)).toBeInTheDocument()
    expect(screen.getByText(/Recepción UTC:/)).toBeInTheDocument()
  })

  it('keeps the strategy in the compact summary and expands selected evidence', () => {
    render(
      <PaperDecisionPanel
        decisions={[decision]}
        selectedId={decision.id}
        onSelect={vi.fn()}
      />,
    )

    expect(screen.getByRole('button')).toHaveTextContent('micro-trend-pullback')
    expect(screen.getByText(/Versión:/)).toBeInTheDocument()
    expect(screen.getByText(/Condiciones:/)).toBeInTheDocument()
  })

  it('keeps the cached decision visible and offers a decision-feed retry when stale', () => {
    const onRetry = vi.fn()
    render(
      <PaperDecisionPanel
        decisions={[decision]}
        selectedId={null}
        onSelect={vi.fn()}
        receivedAt={1_700_000_000_100}
        error="Feed unavailable"
        onRetry={onRetry}
      />,
    )

    expect(screen.getByText(/Consulta cada 5 s/)).toBeInTheDocument()
    expect(
      screen.getByText(/Ventana reciente.*200 decisiones/),
    ).toBeInTheDocument()
    expect(screen.getByText(/Actualizado:/)).toBeInTheDocument()
    expect(
      screen.getByText(/Feed desactualizado: Feed unavailable/),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /micro-trend-pullback/ }),
    ).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', { name: 'Reintentar decisiones' }),
    )
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('shows evaluated gate facts and selects the same backend decision ID', () => {
    const onSelect = vi.fn()
    render(
      <PaperDecisionPanel
        decisions={[decision]}
        selectedId={decision.id}
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
        receivedAt={1_700_000_000_100}
      />,
    )
    expect(
      screen.getByText('Esperando próxima evaluación.'),
    ).toBeInTheDocument()
  })

  it('does not describe a failed initial request as an empty decision feed', () => {
    render(
      <PaperDecisionPanel
        decisions={[]}
        selectedId={null}
        onSelect={vi.fn()}
        error="Feed unavailable"
        onRetry={vi.fn()}
      />,
    )

    expect(
      screen.getByText('No se pudo cargar la lista de decisiones.'),
    ).toBeInTheDocument()
    expect(
      screen.queryByText('Esperando próxima evaluación.'),
    ).not.toBeInTheDocument()
  })

  it('shows unavailable rationale for legacy records without diagnostics', () => {
    render(
      <PaperDecisionPanel
        decisions={[{ ...decision, reasonCode: null, conditions: [] }]}
        selectedId={null}
        onSelect={vi.fn()}
      />,
    )
    expect(screen.getAllByText('No disponible')).toHaveLength(1)
    expect(screen.getByLabelText('Precio: No disponible')).toBeInTheDocument()
  })
})
