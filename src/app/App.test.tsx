import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App.tsx'

vi.mock('./TerminalEntry.tsx', () => ({
  default: () => <p>futures terminal</p>,
}))
vi.mock('./LaboratoryPage.tsx', () => ({
  default: () => <p>strategy laboratory</p>,
}))

describe('App routing', () => {
  afterEach(() => window.history.pushState({}, '', '/'))

  it.each(['/', '/terminal', '/demo', '/historicos'])(
    'renders the futures terminal at %s',
    (path) => {
      window.history.pushState({}, '', path)
      render(<App />)
      expect(screen.getByText('futures terminal')).toBeVisible()
    },
  )

  it('renders the strategy laboratory at /estrategias', () => {
    window.history.pushState({}, '', '/estrategias')
    render(<App />)
    expect(screen.getByText('strategy laboratory')).toBeVisible()
  })
})
