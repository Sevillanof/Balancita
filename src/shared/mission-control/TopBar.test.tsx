import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import TopBar from './TopBar.tsx'
import AppShell from './AppShell.tsx'

afterEach(cleanup)
const navigation = [
  { href: '/terminal', label: 'Terminal', current: true },
  { href: '/estrategias', label: 'Estrategias' },
]
const props = {
  navigation,
  brandHref: '/',
  brandLabel: 'Balancita, volver a la aplicación',
  center: <span>Cuenta paper</span>,
  status: <span>Salud: revisar</span>,
}

describe('compact account-focused application header', () => {
  it('uses a simple scales glyph, without the former drawing or wordmark', () => {
    render(<TopBar {...props} />)
    expect(screen.getByText('⚖️')).toBeTruthy()
    expect(screen.queryByText(/balancita[.]/i)).toBeNull()
    expect(
      screen.getByRole('link', { name: props.brandLabel }).querySelector('svg'),
    ).toBeNull()
  })

  it('keeps real navigation links and indicates selection without tags', () => {
    render(<TopBar {...props} />)
    const terminal = screen.getByRole('link', { name: 'Terminal' })
    expect(terminal).toHaveAttribute('href', '/terminal')
    expect(terminal).toHaveAttribute('aria-current', 'page')
    expect(terminal.className).not.toMatch(/rounded|bg-long|bg-line/)
    expect(screen.getByRole('link', { name: 'Estrategias' })).toHaveAttribute(
      'href',
      '/estrategias',
    )
  })

  it('bounds only viewport-mode pages, leaving the strategy shell naturally scrollable', () => {
    const view = render(
      <AppShell {...props} viewport>
        <div>Terminal content</div>
      </AppShell>,
    )
    expect(screen.getByTestId('app-shell')).toHaveAttribute(
      'data-layout',
      'viewport',
    )
    expect(screen.getByRole('main')).toHaveClass('min-h-0')
    view.rerender(
      <AppShell {...props}>
        <div>Strategy content</div>
      </AppShell>,
    )
    expect(screen.getByTestId('app-shell')).toHaveAttribute(
      'data-layout',
      'document',
    )
  })
})
