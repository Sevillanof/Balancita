import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  DataProvenance,
  DataState,
  Metric,
  Panel,
  StatusPill,
  TopBar,
} from './index.ts'

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

  it('Panel preserves its region label and caller class without an empty header', () => {
    const { container } = render(
      <Panel label="Detalle" className="caller-panel">
        cuerpo
      </Panel>,
    )
    expect(
      screen
        .getByRole('region', { name: 'Detalle' })
        .classList.contains('caller-panel'),
    ).toBe(true)
    expect(container.querySelector('header')).toBeNull()
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

  it.each([
    ['ok', 'Correcto'],
    ['warn', 'Advertencia'],
    ['bad', 'Error'],
    ['nodata', 'Sin datos'],
  ] as const)(
    'StatusPill preserves the default label for %s',
    (tone, label) => {
      render(<StatusPill tone={tone} />)
      expect(screen.getByText(label).getAttribute('data-tone')).toBe(tone)
    },
  )

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

  it.each([
    ['loading', 'Cargando…'],
    ['error', 'Error'],
    ['empty', 'Sin elementos'],
    ['unavailable', 'No disponible'],
    ['nodata', 'Sin datos'],
  ] as const)(
    'DataState preserves the role and title for %s',
    (kind, title) => {
      const { container, rerender } = render(<DataState kind={kind} />)
      const role = kind === 'error' ? 'alert' : 'status'
      expect(screen.getByRole(role).textContent).toBe(title)
      expect(container.querySelectorAll('p')).toHaveLength(1)
      rerender(<DataState kind={kind} title="Título propio" detail="Detalle" />)
      expect(screen.getByRole(role).textContent).toBe('Título propioDetalle')
    },
  )

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

  it('DataProvenance keeps event time and last received apart and never invents either', () => {
    const { rerender } = render(<DataProvenance />)
    expect(screen.getAllByText('No disponible')).toHaveLength(5)
    rerender(
      <DataProvenance
        origin="Kraken"
        experiment="C29"
        runId="run-7"
        eventTime={1_800_000_000_000}
        receivedAt={1_800_000_005_000}
        now={1_800_000_009_000}
      />,
    )
    expect(screen.queryByText('No disponible')).toBeNull()
    expect(screen.getByText('run-7')).toBeTruthy()
    expect(screen.getByText(/hace 4 s/)).toBeTruthy()
    // Only the received time is given: the event time stays unavailable.
    rerender(<DataProvenance origin="Kraken" receivedAt={1_800_000_005_000} />)
    expect(screen.getAllByText('No disponible')).toHaveLength(3)
    expect(screen.queryByText(/hace/)).toBeNull()
  })
})
