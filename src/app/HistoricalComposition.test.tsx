import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../features/demo/trading/TerminalChart.tsx', () => ({
  default: () => <div role="img" aria-label="Gráfico ilustrativo" />,
}))

vi.mock('../features/demo/history/HistoricalView.tsx', () => ({
  default: ({ provider }: { provider?: unknown }) => (
    <div
      data-testid="historical-view"
      data-provider-injected={provider ? 'true' : 'false'}
    />
  ),
}))

import DemoShell from './DemoShell.tsx'

afterEach(() => {
  window.history.pushState({}, '', '/')
  cleanup()
})

describe('historical provider composition', () => {
  it('injects a provider into the historical presentation at the route boundary', () => {
    window.history.pushState({}, '', '/demo/historicas')
    render(<DemoShell />)

    expect(screen.getByTestId('historical-view')).toHaveAttribute(
      'data-provider-injected',
      'true',
    )
  })
})
