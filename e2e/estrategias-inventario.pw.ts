import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page, type Route } from '@playwright/test'

/*
 * Estrategias = the laboratory of the Terminal. Every /api-strategies answer is a route mock with SYNTHETIC
 * numbers (DATOS DE EJEMPLO): no registry, gateway or database runs, and nothing here is a Kraken record or
 * a real backtest. The file keeps its old name; it no longer covers the retired rule-strategy inventory.
 */
const SHOTS =
  process.env.ESTRATEGIAS_SHOTS_DIR ?? 'playwright-artifacts/estrategias'
const HASH = '37f572a841d35a7b7a8d01569378c508c6bcd9c8a4a6a2adb96e5d1097eade07'
const DESDE = Date.UTC(2026, 1, 3)

const perilla = (clave: string, valor: number | string | null, extra = {}) => ({
  clave,
  tipo: 'entero',
  valor_actual: valor,
  admite_null: false,
  minimo: 0,
  maximo: 10_000,
  minimo_exclusivo: false,
  paso: null,
  ...extra,
})
const PERILLAS = [
  perilla('guardrails.max_hold_min', 2160),
  perilla('guardrails.cooldown_min', 15),
  perilla('posiciones.max', 3),
  perilla('posiciones.fraccion', 0.33, { tipo: 'decimal' }),
  perilla('analista.modo', 'fuerte', {
    tipo: 'opcion',
    opciones: ['apagado', 'suave', 'fuerte'],
  }),
  perilla('reglas_maestro.no_vender_subida_30d', 'apagado', {
    tipo: 'opcion',
    opciones: ['apagado', 'prendido'],
  }),
  perilla('reglas_maestro.sumar_lugares_60min', 'apagado', {
    tipo: 'opcion',
    opciones: ['apagado', 'prendido'],
  }),
]

const fila = (id: string, nombre: string, cambios: object) => ({
  id,
  nombre,
  descripcion: nombre,
  cambios,
  base_config_hash: HASH,
  overlay_sha256: 'a'.repeat(64),
  error: null,
})
const PROBADA = fila('salida-30h', 'Salida a 30 h', {
  guardrails: { max_hold_min: 1800 },
})
const SIN_PROBAR = fila('dos-posiciones', 'Dos posiciones al 50 %', {
  posiciones: { max: 2, fraccion: 0.5 },
})

const HASTA = Date.UTC(2026, 3, 19)
const HORA = 3_600_000
/** The trades sit in the last ten days of the window (what the chart opens on); `horas` is how long each one stays open. */
const operaciones = (netos: number[], horas = 20) =>
  netos.map((neto, i) => {
    const entrada = HASTA - (netos.length - i) * 30 * HORA
    return {
      entrada_ms: entrada,
      salida_ms: entrada + horas * HORA,
      lado: neto >= 0 ? 'LONG' : 'SHORT',
      neto_usd: neto,
      neto_bp: neto * 10,
      motivo: 'tiempo',
      nocional_usd: 300,
    }
  })
const metricas = (patch: object) => ({
  operaciones: 180,
  neto_usd: 97.7,
  neto_bp_cuenta: 977,
  neto_bp_por_operacion: 5.4,
  acierto: 0.54,
  max_drawdown_usd: 31.4,
  max_drawdown_bp: 314,
  horas_promedio: 21.4,
  por_motivo: {},
  ...patch,
})
const INFORME = {
  estrategia: {
    id: PROBADA.id,
    nombre: PROBADA.nombre,
    cambios: PROBADA.cambios,
  },
  snapshot: { config_hash: HASH },
  ventana: {
    desde: '2026-02-01',
    hasta: '2026-04-19',
    desde_efectivo: '2026-02-03',
    desde_ms: Date.UTC(2026, 1, 1),
    hasta_ms: Date.UTC(2026, 3, 19),
    desde_efectivo_ms: DESDE,
    dias: 75,
    reserva: { incluida: false, desde: '2026-04-19' },
  },
  datos: { fuente: 'datos de ejemplo' },
  limites: ['sin noticias', 'sin libro de órdenes', 'sin posicionamiento'],
  oficial: {
    config_hash: HASH,
    metricas: metricas({}),
    operaciones: operaciones([30, -10, 50, 27.7, -8, 12]),
  },
  variante: {
    config_hash: 'e'.repeat(64),
    metricas: metricas({
      operaciones: 182,
      neto_usd: 53.63,
      neto_bp_por_operacion: 2.9,
      acierto: 0.52,
      max_drawdown_usd: 38.2,
      horas_promedio: 18.9,
    }),
    operaciones: operaciones([20, -15, 30, 18.63, -12, 12], 14),
  },
  diferencia: {
    operaciones: 2,
    neto_usd: -44.07,
    neto_bp_cuenta: -440.7,
    neto_bp_por_operacion: -2.5,
    acierto: -0.02,
    max_drawdown_usd: 6.8,
    max_drawdown_bp: 68,
    horas_promedio: -2.5,
  },
}
const trabajo = (id: string, patch: object) => ({
  job_id: 'job1',
  estrategia_id: id,
  estado: 'listo',
  desde: '2026-02-01',
  hasta: '2026-04-19',
  iniciado_ms: 1_000,
  terminado_ms: 23_000,
  informe: INFORME,
  error: null,
  ...patch,
})

const PASO: Record<string, number> = {
  '15m': 15 * 60_000,
  '1h': HORA,
  '4h': 4 * HORA,
  '1d': 24 * HORA,
}
/** SYNTHETIC candles with the contract of GET /estrategias/velas: complete candles of [desde, hasta) before `antes`, the newest `limite`. */
function velasDeEjemplo(partes: RegExpExecArray) {
  const [, producto, intervalo, desde, hasta, antes, limite] = partes
  const paso = PASO[intervalo]
  const inicio = Math.ceil(Number(desde) / paso) * paso
  const corte = Math.floor(Math.min(Number(antes), Number(hasta)) / paso) * paso
  const primera = Math.max(inicio, corte - Number(limite) * paso)
  const velas = []
  for (let t = primera; t < corte; t += paso) {
    const base = 2200 + 90 * Math.sin(t / (paso * 30)) + (t % (paso * 7)) / paso
    const cierre = base + 14 * Math.cos(t / paso)
    velas.push({
      t,
      o: base,
      h: Math.max(base, cierre) + 9,
      l: Math.min(base, cierre) - 9,
      c: cierre,
      v: 10,
    })
  }
  return {
    producto,
    intervalo,
    desde_ms: inicio,
    hasta_ms: Math.floor(Number(hasta) / paso) * paso,
    velas,
    hay_mas: velas.length > 0 && primera > inicio,
  }
}

/** The candle requests of the page, as paths, since the last mockRegistry. */
let consultasVelas: string[] = []

/** Mocks the whole /api-strategies surface; returns what the page posted. */
async function mockRegistry(page: Page) {
  const publicadas: unknown[] = []
  consultasVelas = []
  const estrategias = [PROBADA, SIN_PROBAR]
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, json: body })
  await page.route('**/api-live/**', (route) =>
    route.fulfill({ status: 503, json: {} }),
  )
  await page.route('**/api-strategies/**', async (route) => {
    const request = route.request()
    const ruta = new URL(request.url()).pathname.replace('/api-strategies', '')
    if (ruta === '/health') return json(route, { status: 'ok' })
    if (ruta === '/estrategias' && request.method() === 'GET')
      return json(route, {
        snapshot: {
          config_hash: HASH,
          origen: { version_id: 3, activada_utc: '2026-11-02T14:15:54.811Z' },
        },
        ventana_honesta: { desde: '2026-02-01', hasta: '2026-04-19' },
        perillas: PERILLAS,
        estrategias,
      })
    if (ruta === '/estrategias' && request.method() === 'POST') {
      const cuerpo = request.postDataJSON() as { nombre: string }
      publicadas.push(cuerpo)
      const nueva = fila('nueva-variante', cuerpo.nombre, {})
      estrategias.push(nueva)
      return json(route, nueva)
    }
    const velas =
      /^\/estrategias\/velas\/([^/]+)\/([^/]+)\/(\d+)\/(\d+)\/(\d+)\/(\d+)$/.exec(
        ruta,
      )
    if (velas && request.method() === 'GET') {
      consultasVelas.push(ruta)
      return json(route, velasDeEjemplo(velas))
    }
    const comparar = /^\/estrategias\/([^/]+)\/comparar(?:\/[^/]+)?$/.exec(ruta)
    if (comparar && request.method() === 'POST')
      return json(
        route,
        trabajo(comparar[1], {
          estado: 'corriendo',
          informe: null,
          terminado_ms: null,
        }),
      )
    if (comparar && comparar[1] === PROBADA.id)
      return json(route, trabajo(PROBADA.id, {}))
    return json(route, { error: 'sin_comparacion', detail: 'x' }, 404)
  })
  return publicadas
}

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true })
  await page.evaluate(() => {
    document.getElementById('sandbox-note')?.remove()
    const bar = document.createElement('div')
    bar.id = 'sandbox-note'
    bar.textContent =
      'DATOS DE EJEMPLO · respuestas simuladas, no es un backtest real'
    bar.style.cssText =
      'padding:4px 8px;font:11px monospace;color:#f59e0b;background:#0a0d14;border-bottom:1px solid #f59e0b;text-align:center'
    document.body.prepend(bar)
  })
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true })
}

test('Estrategias lists the variants and draws the comparison of the chosen one', async ({
  page,
}) => {
  await mockRegistry(page)
  await page.goto('/estrategias')

  const lista = page.getByRole('list', { name: 'Lista de variantes' })
  await expect(
    lista.getByRole('button', { name: /Salida a 30 h/ }),
  ).toContainText('Peor que la oficial')
  await expect(
    lista.getByRole('button', { name: /Dos posiciones/ }),
  ).toContainText('Sin probar')
  await expect(
    page.getByRole('region', { name: 'Terminal activa' }),
  ).toContainText('Versión 3')

  const detalle = page.getByRole('region', {
    name: /Detalle de «Salida a 30 h»/,
  })
  const velas = detalle.getByRole('img', { name: /Velas de ETH/ })
  await expect(velas).toBeVisible()
  await expect(detalle.getByText('Saldo acumulado')).toHaveCount(0)
  await expect(detalle.getByTitle('180 operaciones')).toBeVisible()
  await expect(
    detalle.getByRole('group', { name: 'Peor caída' }),
  ).toContainText('+6,80 US$ peor')
  await expect(
    detalle.getByRole('list', { name: 'Condiciones de la prueba' }),
  ).toContainText('Reserva intacta')

  // No page or detail title, and nothing from the retired rule strategies.
  await expect(page.getByRole('heading')).toHaveCount(0)
  await expect(page.getByText(/C2[5-9]|C3[0-3]|VectorBT|ranking/i)).toHaveCount(
    0,
  )

  // Both panels use the height of the window and the chart takes what is left.
  const viewport = page.viewportSize()!
  if (viewport.width >= 1000) {
    const alto = (await detalle.boundingBox())!.height
    expect(alto).toBeGreaterThan(viewport.height * 0.6)
    const grafico = (await velas.boundingBox())!
    expect(grafico.height).toBeGreaterThan(120)
  }
  const ancho = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }))
  expect(ancho.scroll).toBeLessThanOrEqual(ancho.client)
  await shot(page, 'estrategias-detalle')

  await detalle.getByRole('button', { name: 'Ver operaciones' }).click()
  await expect(
    page.getByRole('dialog', { name: 'Operaciones del backtest' }),
  ).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('Estrategias draws one trade at a time on the ETH candles of the tested window, with the exits of the official, the variant and the ideal', async ({
  page,
}) => {
  await mockRegistry(page)
  await page.goto('/estrategias')
  const detalle = page.getByRole('region', {
    name: /Detalle de «Salida a 30 h»/,
  })
  const una = detalle.getByRole('img', { name: /Velas de ETH alrededor/ })
  await expect(una).toBeVisible()
  await expect(detalle.getByTestId('velas')).toBeVisible()

  // The chart asks once for the stretch around the chosen trade (the 4th of 6), inside the tested window, never the reserve.
  await expect
    .poll(() => consultasVelas[0])
    .toBe(
      `/estrategias/velas/PF_ETHUSD/1h/${DESDE}/${HASTA}/${HASTA - 30 * HORA}/121`,
    )

  // Header: ‹ ›, «Operación N de M», side, date, mode toggle and a one-line legend.
  await expect(detalle.getByText('Operación 4 de 6')).toBeVisible()
  await expect(detalle.getByText('▲ LONG')).toBeVisible()
  await expect(
    detalle.getByRole('button', { name: 'Una operación' }),
  ).toHaveAttribute('aria-pressed', 'true')
  const leyenda = detalle.getByLabel('Leyenda')
  await expect(leyenda).toHaveText('OficialVarianteIdeal')
  const cajaLeyenda = (await leyenda.boundingBox())!
  expect(cajaLeyenda.height).toBeLessThan(24)

  // Entry line, entry pill and one pill with the net per exit, none over another; the side panel has the three exits.
  await expect(detalle.getByTestId('pildora-entrada')).toContainText('entrada')
  for (const quien of ['oficial', 'variante', 'ideal'])
    await expect(detalle.getByTestId(`pildora-${quien}`)).toBeVisible()
  const cajas = await Promise.all(
    ['entrada', 'oficial', 'variante', 'ideal'].map(
      async (q) => (await detalle.getByTestId(`pildora-${q}`).boundingBox())!,
    ),
  )
  for (let a = 0; a < cajas.length; a++)
    for (let b = a + 1; b < cajas.length; b++) {
      const p = cajas[a]!
      const q = cajas[b]!
      expect(
        p.x < q.x + q.width &&
          q.x < p.x + p.width &&
          p.y < q.y + q.height &&
          q.y < p.y + p.height,
      ).toBe(false)
    }
  const panel = detalle.getByRole('list', { name: 'Resultado de cada salida' })
  await expect(panel).toContainText('+27,7 US$')
  await expect(panel).toContainText('tope 30 h')
  await expect(panel).toContainText('mejor precio posible')
  await expect(panel).toContainText('Le faltó a la oficial')

  // Inside its panel, nothing sticks out, and no TradingView logo.
  const figura = (await detalle.locator('figure').boundingBox())!
  const seccion = (await detalle.boundingBox())!
  const svg = (await una.boundingBox())!
  expect(svg.y + svg.height).toBeLessThanOrEqual(figura.y + figura.height)
  expect(svg.x + svg.width).toBeLessThanOrEqual(figura.x + figura.width)
  expect(figura.y + figura.height).toBeLessThanOrEqual(
    seccion.y + seccion.height,
  )
  const volver = (await detalle
    .getByRole('button', { name: 'Volver a correr' })
    .boundingBox())!
  expect(volver.y + volver.height).toBeLessThanOrEqual(
    seccion.y + seccion.height,
  )
  await expect(page.locator('a[href*="tradingview"]')).toHaveCount(0)
  await expect(page.getByText(/tradingview/i)).toHaveCount(0)
  await shot(page, 'estrategias-una-operacion')

  // ‹ › move between trades.
  await detalle.getByRole('button', { name: 'Operación siguiente' }).click()
  await expect(detalle.getByText('Operación 5 de 6')).toBeVisible()
  await detalle.getByRole('button', { name: 'Operación anterior' }).click()
  await detalle.getByRole('button', { name: 'Operación anterior' }).click()
  await expect(detalle.getByText('Operación 3 de 6')).toBeVisible()
  await expect(detalle.getByText('▲ LONG')).toBeVisible()

  // «Varias»: one bar per trade under the candles; clicking one zooms into it.
  await detalle.getByRole('button', { name: 'Varias' }).click()
  await expect(
    detalle.getByRole('group', { name: /Velas de ETH de unos cinco días/ }),
  ).toBeVisible()
  const barras = detalle.getByTestId('barra-operacion')
  await expect.poll(() => barras.count()).toBeGreaterThanOrEqual(3)
  // a vertical line has no width: it is in the DOM, drawn amber where the variant left at another moment
  await expect(detalle.getByTestId('corte-variante')).not.toHaveCount(0)
  await shot(page, 'estrategias-varias')
  await barras.nth(1).locator('rect').click()
  await expect(
    detalle.getByRole('button', { name: 'Una operación' }),
  ).toHaveAttribute('aria-pressed', 'true')
  await expect(
    detalle.getByRole('img', { name: /Velas de ETH alrededor/ }),
  ).toBeVisible()
  await expect(detalle.getByText(/^Operación \d de 6$/)).toBeVisible()

  // The timeframe buttons ask for that interval, always inside the tested window.
  await detalle.getByRole('button', { name: '4h', exact: true }).click()
  await expect(
    detalle.getByRole('button', { name: '4h', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true')
  await expect
    .poll(() => consultasVelas.at(-1))
    .toMatch(
      new RegExp(
        `^/estrategias/velas/PF_ETHUSD/4h/${DESDE}/${HASTA}/\\d+/\\d+$`,
      ),
    )
  for (const ruta of consultasVelas)
    expect(Number(ruta.split('/')[7])).toBeLessThanOrEqual(HASTA)
})

test('Estrategias creates a variant with only the allowed knobs and starts its backtest', async ({
  page,
}) => {
  const publicadas = await mockRegistry(page)
  await page.goto('/estrategias')
  await page.getByRole('button', { name: '+ Nueva variante' }).click()
  const form = page.getByRole('form', { name: 'Nueva variante' })
  await expect(form.getByLabel('Tope de horas')).toHaveValue('36')
  await expect(form.getByText('hoy 36 h')).toBeVisible()
  await expect(form).toContainText('maestro y portero no se tocan')
  await shot(page, 'estrategias-nueva')

  await form.getByLabel('Nombre').fill('Salida a 24 h')
  await form.getByLabel('Tope de horas').fill('24')
  await form.getByRole('button', { name: 'Crear y probar' }).click()
  await expect(form).toHaveCount(0)
  expect(publicadas).toEqual([
    {
      nombre: 'Salida a 24 h',
      descripcion: 'Tope de horas 36 h → 24 h',
      cambios: { guardrails: { max_hold_min: 1440 } },
    },
  ])
})

test('Estrategias without the registry shows the error and no example data', async ({
  page,
}) => {
  await page.route('**/api-strategies/**', (route) =>
    route.fulfill({ status: 503, json: {} }),
  )
  await page.route('**/api-live/**', (route) =>
    route.fulfill({ status: 503, json: {} }),
  )
  await page.goto('/estrategias')
  await expect(page.getByRole('alert').first()).toContainText(
    'No se muestran datos de ejemplo',
  )
  await expect(
    page.getByRole('list', { name: 'Lista de variantes' }),
  ).toHaveCount(0)
})
