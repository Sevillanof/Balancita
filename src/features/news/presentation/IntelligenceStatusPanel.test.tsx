import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import IntelligenceStatusPanel from './IntelligenceStatusPanel.tsx'
import type { UseIntelligenceStreamResult } from './useIntelligenceStream.ts'

const baseSnapshot = {
  version: 'intelligence-snapshot.v1' as const,
  instrumentId: 'BTC-EUR' as const,
  generatedAt: 1_700_000_000_000,
  pipeline: {
    status: 'ready' as const,
    collectorEnabled: true,
    connection: 'connected' as const,
    message: 'Market intelligence pipeline is ready.',
  },
  market: {
    source: 'kraken',
    instrumentId: 'BTC-EUR' as const,
    status: 'live' as const,
    price: 60_000,
    eventTime: 1_699_999_999_000,
    receivedTime: 1_699_999_999_500,
    displayTime: 1_699_999_999_500,
    freshness: { ageMs: 500, isStale: false, clockInverted: false },
    sequence: 10,
  },
  observability: {
    windowSize: 10,
    latencyMs: { count: 10, p50: 100, p95: 250 },
    stale: { staleCount: 1, totalCount: 10, rate: 0.1 },
    gaps: {
      gapCount: 1,
      expectedOpportunities: 10,
      rate: 0.1,
      sequenceAvailable: true,
    },
  },
  summaries: {
    analysis: {
      status: 'unavailable' as const,
      reason: 'not_persisted' as const,
    },
    forecast: {
      status: 'unavailable' as const,
      reason: 'no_forecast' as const,
    },
    news: { status: 'unavailable' as const, reason: 'no_news' as const },
  },
}

function stream(
  overrides: Partial<UseIntelligenceStreamResult> = {},
): UseIntelligenceStreamResult {
  return {
    status: 'ready',
    snapshot: baseSnapshot,
    error: null,
    reconnectAttempt: 0,
    clientReceivedAtMs: null,
    transportStatus: 'connected',
    ...overrides,
  }
}

describe('IntelligenceStatusPanel', () => {
  it('shows connection, server timestamps and SLI metrics', () => {
    render(<IntelligenceStatusPanel dataMode="real" stream={stream()} />)

    expect(
      screen.getByRole('region', { name: 'Estado de inteligencia BTC-EUR' }),
    ).toBeInTheDocument()
    expect(screen.getByText('Conectado')).toBeInTheDocument()
    expect(screen.getByText('Modo: Datos reales')).toBeInTheDocument()
    expect(screen.getByText('Latencia p50')).toBeInTheDocument()
    expect(screen.getByText('100 ms')).toBeInTheDocument()
    expect(screen.getByText('Latencia p95')).toBeInTheDocument()
    expect(screen.getByText('250 ms')).toBeInTheDocument()
    expect(
      within(screen.getByLabelText('Indicadores de servicio')).getAllByText(
        '10.0%',
      ),
    ).toHaveLength(2)
    expect(screen.getByText('Edad de frescura')).toBeInTheDocument()
    expect(screen.getByText('500 ms')).toBeInTheDocument()
  })

  it('does not hide disabled or stale warnings', () => {
    render(
      <IntelligenceStatusPanel
        dataMode="simulated"
        stream={stream({
          status: 'disabled',
          snapshot: {
            ...baseSnapshot,
            pipeline: {
              ...baseSnapshot.pipeline,
              status: 'disabled',
              collectorEnabled: false,
              connection: 'disabled',
              message: 'Market collector is disabled.',
            },
            market: null,
            observability: null,
          },
        })}
      />,
    )

    expect(screen.getByText(/Colector deshabilitado:/)).toBeInTheDocument()
    expect(screen.getByText(/no está generando datos/)).toBeInTheDocument()
    expect(screen.getByText('no persistido')).toBeInTheDocument()
  })
})
