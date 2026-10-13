import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DataState, Metric, Panel, StatusPill, TopBar } from './index.ts'

describe('Mission Control components', () => {
  it('Panel renders title, eyebrow, actions and body', () => {
    render(
      <Panel title="Posición" eyebrow="PF_XBTUSD" actions={<button>Ok</button>}>
        cuerpo
      </Panel>,
    )
    expect(screen.getByRole('heading', { name: 'Posición' })).toBeTruthy()
    expect(screen.getByText('PF_XBTUSD')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Ok' })).toBeTruthy()
    expect(screen.getByText('cuerpo')).toBeTruthy()
  })

  it('Metric shows the given value unchanged', () => {
    const { container } = render(
      <Metric label="Neto" value="−11,2 pb" tone="down" hint="n=625" />,
    )
    expect(screen.getByText('−11,2 pb')).toBeTruthy()
    expect(container.querySelector('[data-tone="down"]')).toBeTruthy()
    expect(screen.getByText('n=625')).toBeTruthy()
  })

  it('StatusPill defaults to the label of its tone and never calls no-data healthy', () => {
    render(
      <>
        <StatusPill tone="nodata" />
        <StatusPill tone="ok">Capturando</StatusPill>
      </>,
    )
    expect(screen.getByText('Sin datos').getAttribute('data-tone')).toBe(
      'nodata',
    )
    expect(screen.getByText('Capturando').getAttribute('data-tone')).toBe('ok')
  })

  it('DataState announces errors as alerts and the rest as status', () => {
    render(
      <>
        <DataState kind="error" detail="Falló la carga" />
        <DataState kind="unavailable" />
      </>,
    )
    expect(screen.getByRole('alert').textContent).toContain('Falló la carga')
    expect(screen.getByRole('status').textContent).toContain('No disponible')
  })

  it('TopBar marks the current page and keeps the header test id', () => {
    render(
      <TopBar
        brandHref="/"
        brandLabel="inicio"
        navigation={[
          { href: '/terminal', label: 'Terminal', current: true },
          { href: '/estrategias', label: 'Estrategias' },
        ]}
        status={<span>estado</span>}
      />,
    )
    expect(screen.getByTestId('approved-trading-header')).toBeTruthy()
    expect(
      screen
        .getByRole('link', { name: 'Terminal' })
        .getAttribute('aria-current'),
    ).toBe('page')
    expect(
      screen
        .getByRole('link', { name: 'Estrategias' })
        .getAttribute('aria-current'),
    ).toBeNull()
    expect(screen.getByText('estado')).toBeTruthy()
  })
})
