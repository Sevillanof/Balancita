import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import EstrategiasPage from './EstrategiasPage.tsx'
import StrategyLab from './StrategyLab.tsx'
import {
  EstrategiasApiError,
  type Informe,
} from '../infrastructure/estrategias-api.ts'
import {
  EJEMPLO,
  ESPERA,
  INFORME,
  PERILLAS,
  PERILLAS_DE_TAMANO,
  REBOTES,
  VIEJA,
  fakeApi,
  trabajo,
  trabajoListo,
} from '../testing/estrategias-fixture.ts'

vi.mock(
  'lightweight-charts',
  async () => (await import('../testing/lightweight-charts-mock.ts')).modulo,
)

const OLD_UI = /C2[5-9]|C3[0-3]|VectorBT|ranking|exigencia|editor de reglas/i

const MEJOR: Informe = {
  ...INFORME,
  diferencia: { ...INFORME.diferencia, neto_usd: 12.5 },
}

const renderPage = (api = fakeApi()) =>
  render(<EstrategiasPage api={api} connectError={null} pollMs={5} />)

const tarjeta = (nombre: string) =>
  within(screen.getByRole('list', { name: 'Lista de variantes' }))
    .getByText(nombre)
    .closest('button') as HTMLElement

describe('Estrategias: the Terminal laboratory', () => {
  it('shows the Terminal that operates, with its honest-window result once a comparison exists', async () => {
    renderPage(fakeApi([EJEMPLO], { [EJEMPLO.id]: trabajoListo() }))
    const activa = await screen.findByRole('region', {
      name: 'Terminal activa',
    })
    expect(activa).toHaveTextContent('Terminal activa · la que opera')
    expect(activa).toHaveTextContent('Versión 3')
    expect(activa).toHaveTextContent('37f572…')
    expect(activa).toHaveTextContent('desde 2 nov')
    await waitFor(() => expect(activa).toHaveTextContent('Ventana honesta'))
    expect(activa).toHaveTextContent('180 ops')
    expect(activa).toHaveTextContent('+97,70 US$')
  })

  it('lists the variants with what they change and their status', async () => {
    const api = fakeApi([EJEMPLO, REBOTES, ESPERA], {
      [EJEMPLO.id]: trabajoListo(),
      [ESPERA.id]: trabajo({
        estrategia_id: ESPERA.id,
        iniciado_ms: Date.now() - 12_000,
      }),
    })
    api.trabajo.mockImplementation(async (id: string) =>
      trabajo({ estrategia_id: id, iniciado_ms: Date.now() - 12_000 }),
    )
    renderPage(api)
    await screen.findByText('Variantes · 3')
    const peor = tarjeta('Salida a 30 h')
    await waitFor(() => expect(peor).toHaveTextContent('Peor que la oficial'))
    expect(peor).toHaveTextContent('Tope de horas 36 h → 30 h')
    expect(peor).toHaveTextContent('182 ops')
    expect(peor).toHaveTextContent('−44,07 US$ vs oficial')
    expect(peor).toHaveAttribute('aria-current', 'true')

    const sinProbar = tarjeta('Rebotes más exigentes')
    await waitFor(() => expect(sinProbar).toHaveTextContent('Sin probar'))
    expect(sinProbar).toHaveTextContent('Caída que dispara 5 % → 6 %')
    expect(sinProbar).not.toHaveAttribute('aria-current', 'true')

    const probando = tarjeta('Sin espera tras cerrar')
    await waitFor(() => expect(probando).toHaveTextContent('Probando…'))
    expect(probando).toHaveTextContent('Espera tras cerrar 15 min → 0 min')
    expect(probando).toHaveTextContent(/corriendo · \d+ s/)
  })

  it('tags a variant that beats the official one', async () => {
    renderPage(
      fakeApi([EJEMPLO], {
        [EJEMPLO.id]: trabajoListo({ informe: MEJOR }),
      }),
    )
    await screen.findByText('Variantes · 1')
    await waitFor(() =>
      expect(tarjeta('Salida a 30 h')).toHaveTextContent(
        'Mejor que la oficial',
      ),
    )
    expect(tarjeta('Salida a 30 h')).toHaveTextContent('+12,50 US$ vs oficial')
  })

  it('draws the comparison of the chosen variant: stages, net bars, curve, tiles and conditions', async () => {
    renderPage(fakeApi([EJEMPLO], { [EJEMPLO.id]: trabajoListo() }))
    const detalle = await screen.findByRole('region', {
      name: /Detalle de «Salida a 30 h»/,
    })
    await within(detalle).findByRole('list', { name: 'Etapas de la variante' })
    const etapas = within(detalle).getAllByRole('listitem')
    expect(etapas[0]).toHaveTextContent('Backtest')
    expect(etapas[0]).toHaveTextContent('listo · 22 s')
    expect(etapas[1]).toHaveTextContent('Sombra')
    expect(etapas[1]).toHaveTextContent('0 / 100 operaciones')
    expect(etapas[1]).toHaveAttribute('aria-disabled', 'true')
    expect(etapas[1]).toHaveAttribute(
      'title',
      expect.stringMatching(/próximamente/i),
    )
    expect(etapas[2]).toHaveTextContent('Promover')
    expect(etapas[2]).toHaveAttribute('aria-disabled', 'true')

    const duelo = within(detalle).getByLabelText('Neto del backtest')
    expect(within(duelo).getByText('Oficial')).toBeVisible()
    expect(within(duelo).getByText('Variante')).toBeVisible()
    expect(within(duelo).getByTitle('180 operaciones')).toHaveTextContent(
      /^180$/,
    )
    expect(within(duelo).getByTitle('182 operaciones')).toHaveTextContent(
      /^182$/,
    )
    expect(duelo).toHaveTextContent('+97,70 US$')
    expect(duelo).toHaveTextContent('+53,63 US$')

    expect(
      within(detalle).getByRole('img', { name: /Velas de ETH/ }),
    ).toBeVisible()
    expect(within(detalle).getByText('ETH / USD')).toBeVisible()

    const neto = within(detalle).getByRole('group', {
      name: 'Neto por operación (ponderado por tamaño)',
    })
    expect(neto).toHaveTextContent('oficial+5,4 pb')
    expect(neto).toHaveTextContent('variante+2,9 pb')
    expect(neto).toHaveTextContent('−2,5 pb')
    const acierto = within(detalle).getByRole('group', { name: 'Acierto' })
    expect(acierto).toHaveTextContent('54 %')
    expect(acierto).toHaveTextContent('52 %')
    expect(acierto).toHaveTextContent('−2 pp')
    const caida = within(detalle).getByRole('group', { name: 'Peor caída' })
    expect(caida).toHaveTextContent('31,40 US$')
    expect(caida).toHaveTextContent('38,20 US$')
    expect(caida).toHaveTextContent('+6,80 US$ peor')
    const horas = within(detalle).getByRole('group', {
      name: 'Horas promedio',
    })
    expect(horas).toHaveTextContent('21,4 h · máx. 36 h')
    expect(horas).toHaveTextContent('18,9 h · máx. 30 h')
    expect(horas).toHaveTextContent('−2,5 h')

    const condiciones = within(detalle).getByRole('list', {
      name: 'Condiciones de la prueba',
    })
    expect(condiciones).toHaveTextContent('3 feb → 19 abr')
    expect(within(condiciones).getByText('Reserva intacta')).toBeVisible()
    for (const [texto, ayuda] of [
      ['Noticias', /no reproduce noticias/i],
      ['Libro', /velas, no por libro/i],
      ['Posicionamiento', /posicionamiento/i],
    ] as const)
      expect(
        within(condiciones).getByText(texto).closest('li'),
      ).toHaveAttribute('title', expect.stringMatching(ayuda))
    expect(
      within(detalle).getByRole('button', { name: 'Ver operaciones' }),
    ).toBeEnabled()
    expect(
      within(detalle).getByRole('button', { name: 'Volver a correr' }),
    ).toBeEnabled()
  })

  it('replaces the equity curve with the ETH candles of the informe window, in the detail', async () => {
    const api = fakeApi([EJEMPLO], { [EJEMPLO.id]: trabajoListo() })
    renderPage(api)
    const detalle = await screen.findByRole('region', {
      name: /Detalle de «Salida a 30 h»/,
    })
    expect(
      await within(detalle).findByRole('img', { name: /Velas de ETH/ }),
    ).toBeVisible()
    expect(within(detalle).queryByText('Saldo acumulado')).toBeNull()
    expect(
      within(detalle).getByRole('group', { name: 'Temporalidad' }),
    ).toBeVisible()
    await waitFor(() =>
      expect(api.velas).toHaveBeenCalledWith(
        expect.objectContaining({
          desdeMs: INFORME.ventana.desde_efectivo_ms,
          hastaMs: INFORME.ventana.hasta_ms,
        }),
      ),
    )
  })

  it('has no page title and no detail title: the top bar says where we are', async () => {
    renderPage(fakeApi([EJEMPLO], { [EJEMPLO.id]: trabajoListo() }))
    await screen.findByRole('img', { name: /Velas de ETH/ })
    expect(screen.queryAllByRole('heading')).toHaveLength(0)
  })

  it('shows only variants of the Terminal: no rule strategies, editor, VectorBT, ranking or gate', async () => {
    const api = fakeApi([EJEMPLO], { [EJEMPLO.id]: trabajoListo() })
    const { container } = renderPage(api)
    await screen.findByRole('img', { name: /Velas de ETH/ })
    expect(container.textContent ?? '').not.toMatch(OLD_UI)
    expect(
      screen.queryByRole('button', {
        name: /VectorBT|ranking|Probar|Activar|Borrar/i,
      }),
    ).toBeNull()
    expect(Object.keys(api).sort()).toEqual([
      'comparar',
      'crear',
      'listar',
      'trabajo',
      'ultimo',
      'velas',
    ])
  })

  it('shows a chip per configuration with the trades closed at the end of the window, only when there are some', async () => {
    const conCierres: Informe = {
      ...INFORME,
      oficial: {
        ...INFORME.oficial,
        metricas: {
          ...INFORME.oficial.metricas,
          cerradas_fin_ventana: { operaciones: 2, neto_usd: -3.2 },
        },
      },
      variante: {
        ...INFORME.variante,
        metricas: {
          ...INFORME.variante.metricas,
          cerradas_fin_ventana: { operaciones: 1, neto_usd: 0.9 },
        },
      },
    }
    renderPage(
      fakeApi([EJEMPLO], {
        [EJEMPLO.id]: trabajoListo({ informe: conCierres }),
      }),
    )
    const condiciones = await screen.findByRole('list', {
      name: 'Condiciones de la prueba',
    })
    expect(
      within(condiciones).getByText(
        '2 cerradas al final de la ventana · −3,20 US$',
      ),
    ).toBeVisible()
    expect(
      within(condiciones).getByText(
        '1 cerrada al final de la ventana · +0,90 US$',
      ),
    ).toBeVisible()
    expect(condiciones).toHaveTextContent('Oficial')
    expect(condiciones).toHaveTextContent('Variante')
  })

  it('shows no such chip when nothing was closed at the end of the window, nor for an informe from before', async () => {
    const ninguna: Informe = {
      ...INFORME,
      oficial: {
        ...INFORME.oficial,
        metricas: {
          ...INFORME.oficial.metricas,
          cerradas_fin_ventana: { operaciones: 0, neto_usd: 0 },
        },
      },
    }
    renderPage(
      fakeApi([EJEMPLO], {
        [EJEMPLO.id]: trabajoListo({ informe: ninguna }),
      }),
    )
    const condiciones = await screen.findByRole('list', {
      name: 'Condiciones de la prueba',
    })
    expect(condiciones).not.toHaveTextContent(/cerrada/)
  })

  it('lists the operations of the backtest, the variant first, and closes with Escape', async () => {
    const user = userEvent.setup()
    renderPage(fakeApi([EJEMPLO], { [EJEMPLO.id]: trabajoListo() }))
    await user.click(
      await screen.findByRole('button', { name: 'Ver operaciones' }),
    )
    const dialogo = screen.getByRole('dialog', {
      name: 'Operaciones del backtest',
    })
    expect(
      within(dialogo).getByRole('button', { name: 'Variante' }),
    ).toHaveAttribute('aria-pressed', 'true')
    let filas = within(dialogo).getAllByRole('row').slice(1)
    expect(filas).toHaveLength(4)
    expect(filas[1]).toHaveTextContent('−15,00')
    expect(filas[1]).toHaveTextContent('Tope de horas')
    await user.click(within(dialogo).getByRole('button', { name: 'Oficial' }))
    filas = within(dialogo).getAllByRole('row').slice(1)
    expect(filas[1]).toHaveTextContent('−10,00')
    expect(filas[1]).toHaveTextContent('Vuelta del maestro')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('offers to run the backtest of a variant that was never tried, and follows it to the result', async () => {
    const user = userEvent.setup()
    const api = fakeApi([REBOTES])
    renderPage(api)
    const detalle = await screen.findByRole('region', {
      name: /Detalle de «Rebotes más exigentes»/,
    })
    expect(
      await within(detalle).findByText('Todavía no se probó'),
    ).toBeVisible()
    expect(detalle).toHaveTextContent('Caída que dispara 5 % → 6 %')
    expect(within(detalle).getAllByRole('listitem')[0]).toHaveTextContent(
      'sin correr',
    )
    await user.click(
      within(detalle).getByRole('button', { name: 'Correr backtest' }),
    )
    expect(api.comparar).toHaveBeenCalledWith(REBOTES.id)
    expect(await screen.findByText('Probando…')).toBeVisible()
    expect(
      await screen.findByRole('img', { name: /Velas de ETH/ }),
    ).toBeVisible()
    await waitFor(() =>
      expect(tarjeta('Rebotes más exigentes')).toHaveTextContent(
        'Peor que la oficial',
      ),
    )
  })

  it('shows a running comparison with its progress and no results yet', async () => {
    const api = fakeApi([EJEMPLO], {
      [EJEMPLO.id]: trabajo({ iniciado_ms: Date.now() - 5_000 }),
    })
    api.trabajo.mockImplementation(async () =>
      trabajo({ iniciado_ms: Date.now() - 5_000 }),
    )
    renderPage(api)
    const detalle = await screen.findByRole('region', {
      name: /Detalle de «Salida a 30 h»/,
    })
    await waitFor(() =>
      expect(within(detalle).getAllByRole('listitem')[0]).toHaveTextContent(
        /corriendo · \d+ s/,
      ),
    )
    expect(detalle).toHaveTextContent('Probando contra la Terminal activa')
    expect(within(detalle).queryByRole('img')).toBeNull()
    expect(
      within(detalle).queryByRole('button', { name: 'Volver a correr' }),
    ).toBeNull()
  })

  it('says so when the server forgot a running comparison (it restarted)', async () => {
    const api = fakeApi([EJEMPLO], {
      [EJEMPLO.id]: trabajo({ iniciado_ms: Date.now() - 5_000 }),
    })
    api.trabajo.mockRejectedValue(
      new EstrategiasApiError('No existe la comparación.', 404),
    )
    renderPage(api)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'El servidor ya no recuerda esta comparación',
    )
    expect(
      screen.getByRole('button', { name: 'Volver a correr' }),
    ).toBeEnabled()
    expect(tarjeta('Salida a 30 h')).toHaveTextContent('Falló')
  })

  it('says what failed and lets you run again', async () => {
    const user = userEvent.setup()
    const api = fakeApi([EJEMPLO], {
      [EJEMPLO.id]: trabajo({
        estado: 'error',
        terminado_ms: 5_000,
        error: 'No hay velas en la caché para ETH.',
      }),
    })
    renderPage(api)
    const alerta = await screen.findByRole('alert')
    expect(alerta).toHaveTextContent('No hay velas en la caché para ETH.')
    expect(tarjeta('Salida a 30 h')).toHaveTextContent('Falló')
    await user.click(screen.getByRole('button', { name: 'Volver a correr' }))
    expect(api.comparar).toHaveBeenCalledWith(EJEMPLO.id)
  })

  it('runs again from the result and shows a refusal of the server', async () => {
    const user = userEvent.setup()
    const api = fakeApi([EJEMPLO], { [EJEMPLO.id]: trabajoListo() })
    api.comparar.mockRejectedValueOnce(
      new EstrategiasApiError('Ya hay una comparación corriendo.', 409),
    )
    renderPage(api)
    await user.click(
      await screen.findByRole('button', { name: 'Volver a correr' }),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Ya hay una comparación corriendo.',
    )
    expect(screen.getByRole('img', { name: /Velas de ETH/ })).toBeVisible()
  })

  it('says why a variant cannot be tried instead of offering the backtest', async () => {
    renderPage(fakeApi([VIEJA]))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /no se puede probar.*no coincide con el hash/,
    )
    expect(tarjeta('Vieja')).toHaveTextContent('No se puede probar')
    expect(screen.queryByRole('button', { name: 'Correr backtest' })).toBeNull()
  })

  it('invites to create the first variant when there are none', async () => {
    renderPage(fakeApi([]))
    expect(await screen.findByText('Variantes · 0')).toBeVisible()
    expect(screen.getByText('Todavía no hay variantes.')).toBeVisible()
    expect(
      screen.getByRole('button', { name: '+ Nueva variante' }),
    ).toBeEnabled()
  })

  it('shows the connection error without example data', () => {
    render(<EstrategiasPage api={null} connectError="HTTP 503" />)
    expect(screen.getByRole('alert')).toHaveTextContent(
      'HTTP 503 No se muestran datos de ejemplo.',
    )
  })

  it('shows the list error', async () => {
    const api = fakeApi(
      [],
      {},
      {
        listar: async () => {
          throw new EstrategiasApiError('El snapshot no coincide.', 500)
        },
      },
    )
    renderPage(api)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'El snapshot no coincide.',
    )
  })

  it('StrategyLab connects through the registry probe and shows the list', async () => {
    render(<StrategyLab connect={async () => fakeApi()} pollMs={5} />)
    expect(await screen.findByText('Salida a 30 h')).toBeVisible()
  })

  it('StrategyLab shows a failed connection', async () => {
    render(
      <StrategyLab
        connect={async () => {
          throw new Error('El registro de estrategias no responde (HTTP 503).')
        }}
      />,
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /no responde.*No se muestran datos de ejemplo/,
    )
  })
})

describe('New variant', () => {
  async function abrir(
    api = fakeApi([EJEMPLO], { [EJEMPLO.id]: trabajoListo() }),
  ) {
    const user = userEvent.setup()
    renderPage(api)
    await user.click(
      await screen.findByRole('button', { name: '+ Nueva variante' }),
    )
    const form = await screen.findByRole('form', { name: 'Nueva variante' })
    return { user, api, form }
  }

  it('offers only the allowed knobs, each with its value today', async () => {
    const { form } = await abrir()
    expect(
      within(form).getByRole('heading', { name: 'Nueva variante' }),
    ).toBeVisible()
    expect(within(form).getAllByRole('textbox')).toHaveLength(1 + 6)
    expect(within(form).queryAllByRole('combobox')).toHaveLength(0)
    const tope = within(form).getByLabelText('Tope de horas')
    expect(tope).toHaveValue('36')
    expect(tope).toHaveAccessibleDescription('hoy 36 h')
    expect(within(form).getByText('hoy sin stop')).toBeVisible()
    for (const grupo of ['Salidas', 'Ritmo', 'Rebotes'])
      expect(within(form).getByText(grupo)).toBeVisible()
    expect(form).toHaveTextContent('maestro y portero no se tocan')
    expect(form.textContent ?? '').not.toMatch(
      /maestro_hash|portero\b.*umbral|notional/i,
    )
  })

  it('never offers the sizing rules: the backtest invests exactly like the Terminal', async () => {
    const api = fakeApi([EJEMPLO], { [EJEMPLO.id]: trabajoListo() })
    // a server from before the rule still lists the sizing knobs: the form hides them anyway
    api.listar.mockResolvedValue({
      ...(await api.listar()),
      perillas: [...PERILLAS, ...PERILLAS_DE_TAMANO],
    })
    const { form } = await abrir(api)
    for (const etiqueta of [
      'Máximo abiertas',
      'Tamaño de cada una',
      'Espera entre entradas',
      'Tamaño según volatilidad',
    ])
      expect(within(form).queryByLabelText(etiqueta)).toBeNull()
    expect(within(form).queryByText('Posiciones')).toBeNull()
    expect(within(form).getAllByRole('textbox')).toHaveLength(1 + 6)
    expect(form).toHaveTextContent(
      'El tamaño de cada posición es el de la Terminal y no cambia.',
    )
  })

  it('creates the variant with only what changed, then runs its backtest', async () => {
    const nueva = {
      ...EJEMPLO,
      id: 'mi-variante',
      nombre: 'Mi variante',
    }
    const api = fakeApi([EJEMPLO], { [EJEMPLO.id]: trabajoListo() })
    const { user, form } = await abrir(api)
    api.crear.mockImplementation(async () => {
      api.listar.mockResolvedValue({
        ...(await api.listar()),
        estrategias: [EJEMPLO, nueva],
      })
      return nueva
    })
    await user.type(within(form).getByLabelText('Nombre'), 'Mi variante')
    const tope = within(form).getByLabelText('Tope de horas')
    await user.clear(tope)
    await user.type(tope, '30')
    await user.click(
      within(form).getByRole('button', { name: 'Crear y probar' }),
    )
    await waitFor(() =>
      expect(api.crear).toHaveBeenCalledWith({
        nombre: 'Mi variante',
        descripcion: 'Tope de horas 36 h → 30 h',
        cambios: { guardrails: { max_hold_min: 1800 } },
      }),
    )
    await waitFor(() =>
      expect(api.comparar).toHaveBeenCalledWith('mi-variante'),
    )
    await waitFor(() => expect(screen.queryByRole('form')).toBeNull())
    expect(tarjeta('Mi variante')).toHaveAttribute('aria-current', 'true')
  })

  it('does not post when nothing differs from today', async () => {
    const { user, form, api } = await abrir()
    await user.type(within(form).getByLabelText('Nombre'), 'Igual')
    await user.click(
      within(form).getByRole('button', { name: 'Crear y probar' }),
    )
    expect(await within(form).findByRole('alert')).toHaveTextContent(
      'Cambiá al menos una perilla',
    )
    expect(api.crear).not.toHaveBeenCalled()
  })

  it('names the knob with an invalid value and does not post', async () => {
    const { user, form, api } = await abrir()
    await user.type(within(form).getByLabelText('Nombre'), 'Mala')
    const tope = within(form).getByLabelText('Tope de horas')
    await user.clear(tope)
    await user.type(tope, 'abc')
    await user.click(
      within(form).getByRole('button', { name: 'Crear y probar' }),
    )
    expect(await within(form).findByRole('alert')).toHaveTextContent(
      'Tope de horas',
    )
    expect(api.crear).not.toHaveBeenCalled()
  })

  it('needs a name', async () => {
    const { form } = await abrir()
    expect(
      within(form).getByRole('button', { name: 'Crear y probar' }),
    ).toBeDisabled()
  })

  it('shows the refusal of the server and keeps the form', async () => {
    const { user, form, api } = await abrir()
    api.crear.mockRejectedValueOnce(
      new EstrategiasApiError(
        'Ya existe la estrategia «mi-variante».',
        409,
        'estrategia_existe',
      ),
    )
    await user.type(within(form).getByLabelText('Nombre'), 'Mi variante')
    const tope = within(form).getByLabelText('Tope de horas')
    await user.clear(tope)
    await user.type(tope, '30')
    await user.click(
      within(form).getByRole('button', { name: 'Crear y probar' }),
    )
    expect(await within(form).findByRole('alert')).toHaveTextContent(
      'Ya existe',
    )
    expect(api.comparar).not.toHaveBeenCalled()
    expect(screen.getByRole('form', { name: 'Nueva variante' })).toBeVisible()
  })

  it('closes with Cancelar and gives the detail back', async () => {
    const { user, form } = await abrir()
    await user.click(within(form).getByRole('button', { name: 'Cancelar' }))
    expect(screen.queryByRole('form')).toBeNull()
    expect(
      await screen.findByRole('region', { name: /Detalle de «Salida a 30 h»/ }),
    ).toBeVisible()
  })
})
