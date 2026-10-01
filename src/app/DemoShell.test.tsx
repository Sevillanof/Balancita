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
    expect(screen.getByTestId('approved-trading-header')).toBeInTheDocument()
    expect(
      screen
        .getByLabelText('Balancita, ir a la terminal demo')
        .querySelector('.demo-shell__brand-mark'),
    ).not.toBeNull()
    expect(screen.getByText('DEMO · DATOS SIMULADOS')).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: 'Aplicación actual' }),
    ).toHaveAttribute('href', '/')
    expect(
      screen.getByRole('link', { name: 'Pruebas históricas' }),
    ).toHaveAttribute('href', '/demo/historicas')
  })

  it('selects the functional historical demo route with its empty initial state', () => {
    window.history.pushState({}, '', '/demo/historicas')
    render(<DemoShell />)

    expect(
      screen.getByRole('heading', { name: 'Pruebas históricas' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'Sin resultados todavía' }),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Activo')).toHaveValue('BTC/EUR')
    expect(
      screen.getByRole('button', { name: /ejecutar simulación/i }),
    ).toBeEnabled()
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
