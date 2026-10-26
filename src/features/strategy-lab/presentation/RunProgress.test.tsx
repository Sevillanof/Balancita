import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import RunProgress from './RunProgress.tsx'

describe('RunProgress', () => {
  it.each([
    [-15, 0, '0%'],
    [0, 0, '0%'],
    [37.5, 38, '37.5%'],
    [100, 100, '100%'],
    [140, 100, '100%'],
  ])(
    'bounds progress %s without changing its announced text',
    (percent, now, width) => {
      render(
        <RunProgress
          label="Exploración"
          valueText="Detalle del servidor"
          percent={percent}
        />,
      )
      const bar = screen.getByRole('progressbar', { name: 'Exploración' })
      expect(bar).toHaveAttribute('aria-valuemin', '0')
      expect(bar).toHaveAttribute('aria-valuemax', '100')
      expect(bar).toHaveAttribute('aria-valuenow', String(now))
      expect(bar).toHaveAttribute('aria-valuetext', 'Detalle del servidor')
      expect(within(bar).getByTestId('run-progress-fill')).toHaveStyle({
        width,
      })
    },
  )

  it.each([
    [-20, '0%'],
    [46, '46%'],
    [120, '100%'],
  ])(
    'shows completed, current and pending segments with live progress %s',
    (live, width) => {
      render(
        <RunProgress
          label="Pruebas"
          valueText="Segunda de tres"
          segments={{ done: 1, total: 3, live }}
          percent={50}
        >
          <p>Fase actual</p>
        </RunProgress>,
      )
      const bar = screen.getByRole('progressbar', { name: 'Pruebas' })
      const steps = within(bar).getAllByRole('listitem')
      expect(steps.map((step) => step.dataset.state)).toEqual([
        'done',
        'current',
        'todo',
      ])
      const fills = within(bar).getAllByTestId('run-progress-fill')
      expect(fills[0]).toHaveStyle({ width: '100%' })
      expect(fills[1]).toHaveStyle({ width })
      expect(fills[2]).toHaveStyle({ width: '0%' })
      expect(within(bar).getByText('Fase actual')).toBeInTheDocument()
    },
  )

  it('updates the accessible value and fill when work advances', () => {
    const { rerender } = render(
      <RunProgress label="Pruebas" valueText="Esperando" />,
    )
    expect(screen.getByRole('progressbar')).toHaveAttribute(
      'aria-valuenow',
      '0',
    )
    rerender(
      <RunProgress label="Pruebas" valueText="Terminada" percent={100} />,
    )
    expect(screen.getByRole('progressbar')).toHaveAttribute(
      'aria-valuetext',
      'Terminada',
    )
    expect(screen.getByTestId('run-progress-fill')).toHaveStyle({
      width: '100%',
    })
  })
})
