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
const DIA = 86_400_000
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

const operaciones = (netos: number[]) =>
  netos.map((neto, i) => ({
    entrada_ms: DESDE + i * 7 * DIA,
    salida_ms: DESDE + i * 7 * DIA + 20 * 3_600_000,
    lado: neto >= 0 ? 'LONG' : 'SHORT',
    neto_usd: neto,
    neto_bp: neto * 10,
    motivo: 'tiempo',
  }))
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
    operaciones: operaciones([20, -15, 30, 18.63, -12, 12]),
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

/** Mocks the whole /api-strategies surface; returns what the page posted. */
async function mockRegistry(page: Page) {
  const publicadas: unknown[] = []
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
  await expect(
    detalle.getByRole('img', { name: /Saldo acumulado/ }),
  ).toBeVisible()
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

  // Both panels use the height of the window and the curve takes what is left.
  const viewport = page.viewportSize()!
  if (viewport.width >= 1000) {
    const alto = (await detalle.boundingBox())!.height
    expect(alto).toBeGreaterThan(viewport.height * 0.6)
    const curva = (await detalle
      .getByRole('img', { name: /Saldo acumulado/ })
      .boundingBox())!
    expect(curva.height).toBeGreaterThan(120)
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
