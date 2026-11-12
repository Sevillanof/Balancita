import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import Repeticion from './Repeticion.tsx'
import { INFORME, fakeApi } from '../testing/estrategias-fixture.ts'
import type { EstrategiasApi } from '../infrastructure/estrategias-api.ts'

const montar = () => {
  const api = fakeApi()
  render(
    <Repeticion api={api as unknown as EstrategiasApi} informe={INFORME} />,
  )
  return api
}

const horaActual = () => screen.getByTestId('hora-repeticion').textContent

describe('Repeticion', () => {
  it('loads every candle of the window page by page and starts paused at the first one', async () => {
    const api = montar()
    const play = await screen.findByRole('button', { name: 'Reproducir' })
    await waitFor(() => expect(play).toBeEnabled())
    expect(api.velas.mock.calls.length).toBeGreaterThan(1)
    expect(screen.getByRole('img', { name: /Velas de ETH/ })).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Volver al principio' }),
    ).toBeDisabled()
  })

  it('plays candle by candle, can pause and goes back to the start', async () => {
    montar()
    const play = await screen.findByRole('button', { name: 'Reproducir' })
    await waitFor(() => expect(play).toBeEnabled())
    const inicio = horaActual()
    await userEvent.click(play)
    await waitFor(() => expect(horaActual()).not.toBe(inicio))
    await userEvent.click(screen.getByRole('button', { name: 'Pausar' }))
    const quieto = horaActual()
    await new Promise((r) => setTimeout(r, 300))
    expect(horaActual()).toBe(quieto)
    await userEvent.click(
      screen.getByRole('button', { name: 'Volver al principio' }),
    )
    expect(horaActual()).toBe(inicio)
  })

  it('offers x1, x25, x50 and x100, and the interval changes the candles asked for', async () => {
    const api = montar()
    await screen.findByRole('button', { name: 'Reproducir' })
    const velocidad = screen.getByRole('group', { name: 'Velocidad' })
    for (const texto of ['x1', 'x25', 'x50', 'x100'])
      expect(velocidad).toHaveTextContent(texto)
    await userEvent.click(screen.getByRole('button', { name: 'x100' }))
    expect(screen.getByRole('button', { name: 'x100' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await userEvent.click(screen.getByRole('button', { name: '15m' }))
    await waitFor(() =>
      expect(api.velas).toHaveBeenCalledWith(
        expect.objectContaining({ intervalo: '15m' }),
      ),
    )
  })

  it('moves to another instant with the strip and the arrow keys', async () => {
    montar()
    const play = await screen.findByRole('button', { name: 'Reproducir' })
    await waitFor(() => expect(play).toBeEnabled())
    const inicio = horaActual()
    const franja = screen.getByRole('slider', { name: /Momento/ })
    franja.focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(horaActual()).not.toBe(inicio)
  })

  it('says why when the candles cannot be read', async () => {
    const api = fakeApi()
    api.velas.mockRejectedValue(new Error('sin caché'))
    render(
      <Repeticion api={api as unknown as EstrategiasApi} informe={INFORME} />,
    )
    expect(await screen.findByRole('alert')).toHaveTextContent('sin caché')
  })
})
