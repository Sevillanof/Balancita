import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  FakeMarketDataProvider,
  WATCHLIST_INSTRUMENTS,
} from './test/fake-market-data-provider'
import App from './App'

function renderApp() {
  const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS)
  return { provider, ...render(<App provider={provider} />) }
}

describe('App', () => {
  it('renders the Balancita product identity', () => {
    renderApp()

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Balancita',
    )
  })

  it('does not ask for credentials, keys or secrets', () => {
    renderApp()

    expect(
      screen.queryByLabelText(/api key|secret|token|password|credential/i),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByPlaceholderText(/api key|secret|token|password|key/i),
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })
})
