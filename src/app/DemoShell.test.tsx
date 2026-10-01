import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../features/demo/trading/TerminalChart.tsx', () => ({
  default: () => <div role="img" aria-label="Gráfico ilustrativo" />,
}))

import App from './App.tsx'
import DemoShell from './DemoShell.tsx'

afterEach(() => {
  window.history.pushState({}, '', '/')
  cleanup()
})

describe('demo navigation shell', () => {
  it('shows the explicitly labeled demo terminal and preserves the real app link', () => {
    window.history.pushState({}, '', '/demo')
    render(<DemoShell />)

    expect(
      screen.getByRole('heading', { name: 'Terminal' }),
    ).toBeInTheDocument()
    expect(screen.getByText('DEMO · DATOS SIMULADOS')).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: 'Aplicación actual' }),
    ).toHaveAttribute('href', '/')
    expect(
      screen.getByRole('link', { name: 'Pruebas históricas' }),
    ).toHaveAttribute('href', '/demo/historicas')
  })

  it('selects the historical shell route without presenting unbuilt results', () => {
    window.history.pushState({}, '', '/demo/historicas')
    render(<DemoShell />)

    expect(
      screen.getByRole('heading', { name: 'Pruebas históricas' }),
    ).toBeInTheDocument()
    expect(
      screen.getByText('Esta pantalla se completará en FE-A-04.'),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: 'Pruebas históricas' }),
    ).toHaveAttribute('aria-current', 'page')
  })

  it('routes demo URLs through the shell without mounting the existing dashboard', () => {
    window.history.pushState({}, '', '/demo')
    render(<App />)

    expect(
      screen.getByRole('heading', { name: 'Terminal' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: 'Balancita (BTC/EUR)' }),
    ).not.toBeInTheDocument()
  })
})
