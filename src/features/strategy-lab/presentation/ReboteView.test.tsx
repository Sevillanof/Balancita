import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it } from 'vitest'
import ReboteView from './ReboteView.tsx'
import { useReboteModel } from './rebote-model.ts'
import { rebote } from './rebote-fixture.ts'

function Harness() {
  const model = useReboteModel(rebote)
  return model ? <ReboteView rebote={rebote} model={model} /> : null
}

it('muestra la cuenta entera: 1.000 USD → lo ganado, y marca cada caída en el gráfico', () => {
  render(<Harness />)
  expect(screen.getByTestId('rebote-total')).toHaveTextContent('+45,00 USD')
  expect(screen.getByTestId('rebote-view')).toHaveTextContent(
    '1.000,00 USD → 1.045,00 USD',
  )
  expect(screen.getAllByTestId('drop-mark')).toHaveLength(2)
  expect(screen.getByTestId('drop-legend')).toBeInTheDocument()
  expect(screen.getByTestId('rebote-honesty')).toHaveTextContent(
    'no prueba que funcione',
  )
  expect(screen.getByTestId('account-curve')).toBeInTheDocument()
})

it('cambia a 100 USD fijos y la segunda operación ya no usa la cuenta ganada', async () => {
  const user = userEvent.setup()
  render(<Harness />)
  const table = within(screen.getByTestId('rebote-caidas')).getByRole('table')
  expect(table).toHaveTextContent('1.100,00 USD')
  await user.click(screen.getByRole('radio', { name: '100 USD fijos' }))
  expect(screen.getByTestId('rebote-total')).toHaveTextContent('+5,00 USD')
  expect(table).toHaveTextContent('1.005,00 USD')
})

it('compara las dos variantes y cambia a la del filtro de BTC', async () => {
  const user = userEvent.setup()
  render(<Harness />)
  expect(screen.getByTestId('rebote-variante-principal')).toHaveTextContent(
    '2 caídas',
  )
  await user.click(screen.getByTestId('rebote-variante-filtro_btc'))
  expect(screen.getAllByTestId('drop-mark')).toHaveLength(1)
  expect(
    within(screen.getByTestId('rebote-caidas')).getByText('BTC'),
  ).toBeInTheDocument()
  expect(screen.getByTestId('rebote-view')).toHaveTextContent(
    'salida a las 4 h',
  )
})

it('al tocar una caída hace zoom con los precios de 5 minutos, la caída resaltada y la entrada', async () => {
  const user = userEvent.setup()
  render(<Harness />)
  await user.click(
    within(screen.getByTestId('rebote-caidas')).getAllByRole('button')[0]!,
  )
  const chart = screen.getByTestId('market-chart')
  expect(chart).toHaveTextContent('Operación 1')
  expect(chart).toHaveTextContent('caída −5,9 % en 1 h')
  expect(chart).toHaveTextContent('BTC −2,1 %')
  expect(chart).toHaveTextContent('entrada LARGO')
  expect(chart).toHaveTextContent('salida')
  // the comparison uses the size of THIS operation (1.000 USD), not the first one's
  expect(screen.getByTestId('trade-compare')).toHaveTextContent('Ganamos')
})
