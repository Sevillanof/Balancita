import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

/*
 * Integration with the REAL gateway: no route mocks. The gateway runs from
 * `gateway-main.ts` on the dev "live" port with throwaway databases (synthetic
 * fixture data under a temp folder), Vite proxies `/api-live` to it, and the
 * browser talks to Vite. A 404 here means frontend and gateway disagree on a
 * route, which the mocked specs cannot see.
 */
const LIVE_PORT = 8789
const GATEWAY = `http://127.0.0.1:${LIVE_PORT}`

let gateway: ChildProcess | null = null
// Synthetic 15 m candles seeded for B6 (see seed-gateway-sandbox.ts).
let candles = { lastBucket: 0, holes: [] as number[] }

test.describe.configure({ mode: 'serial' })

// Playwright needs the destructured first argument even when it is empty.
// eslint-disable-next-line no-empty-pattern
test.beforeAll(async ({}, info) => {
  test.skip(
    info.project.name !== 'desktop-1440x900',
    'one project only: the gateway owns a fixed port',
  )
  const seeded = JSON.parse(
    execFileSync('node', ['e2e/support/seed-gateway-sandbox.ts'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim(),
  ) as Record<string, unknown>
  candles = {
    lastBucket: seeded.candlesLastBucket as number,
    holes: seeded.candlesHoles as number[],
  }
  // The seed prints more than the gateway's environment: keep only the paths.
  const env = {
    FUTURES_MARKET_DB_PATH: seeded.FUTURES_MARKET_DB_PATH,
    FUTURES_VERDICTS_DB_PATH: seeded.FUTURES_VERDICTS_DB_PATH,
  } as Record<string, string>
  gateway = spawn('node', ['server/src/app/gateway-main.ts'], {
    env: {
      ...process.env,
      ...env,
      HOST: '127.0.0.1',
      PORT: String(LIVE_PORT),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  gateway.stderr?.on('data', (chunk) => (stderr += String(chunk)))
  const deadline = Date.now() + 20_000
  for (;;) {
    try {
      if ((await fetch(`${GATEWAY}/api/observability/health`)).ok) break
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline)
      throw new Error(`the gateway did not start: ${stderr.slice(-800)}`)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
})

test.afterAll(() => {
  gateway?.kill('SIGTERM')
})

test('B1 and B2 answer through the Vite proxy; the old doubled path is a 404', async ({
  request,
}) => {
  const health = await request.get('/api-live/observability/health')
  expect(health.status()).toBe(200)
  expect((await health.json()).schema).toBe('observability-health.v1')
  for (const window of ['3h', '24h']) {
    const res = await request.get(
      `/api-live/observability/activity?window=${window}&product=PF_XBTUSD`,
    )
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.window).toBe(window)
    expect(body.product).toBe('PF_XBTUSD')
  }
  // What the frontend asked for before the fix: /api/api/... at the gateway.
  expect(
    (await request.get('/api-live/api/observability/health')).status(),
  ).toBe(404)
})

test('B6 candles on the real gateway: bounded range, gaps reported not filled, 400 and 404 where they belong', async ({
  request,
}) => {
  const QUARTER = 15 * 60_000
  const from = candles.lastBucket - 39 * QUARTER
  const to = candles.lastBucket + QUARTER
  // Through the Vite proxy, the path the frontend will use.
  const res = await request.get(
    `/api-live/observability/candles?product=PF_XBTUSD&interval=15m&from=${from}&to=${to}`,
  )
  expect(res.status()).toBe(200)
  const body = await res.json()
  expect(body.schema).toBe('observability-candles.v1')
  expect([body.from_ms, body.to_ms, body.truncated]).toEqual([from, to, false])
  expect(body.candles.state).toBe('ok')
  expect(body.candles.expected).toBe(40)
  expect(body.candles.count).toBe(40 - candles.holes.length)
  expect(body.candles.missing).toBe(candles.holes.length)
  const starts: number[] = body.candles.items.map(
    (i: { bucket_start_ms: number }) => i.bucket_start_ms,
  )
  expect(starts).toEqual([...starts].sort((a, b) => a - b))
  for (const h of candles.holes)
    expect(starts).not.toContain(candles.lastBucket - h * QUARTER)
  expect(body.candles.gaps).toHaveLength(2)
  expect(body.candles.last_bucket_ms).toBe(candles.lastBucket)
  expect(body.candles.last_candle_closed).toBe(true)
  expect(body.candles.items[0]).toHaveProperty('known_at_ms')

  // A product with nothing stored: 200 and an explicit empty state, not 404.
  const empty = await request.get(
    '/api-live/observability/candles?product=PF_ETHUSD&interval=15m&limit=10',
  )
  expect(empty.status()).toBe(200)
  expect((await empty.json()).candles).toMatchObject({ state: 'ok', count: 0 })

  // Explicit 400 with a code; 404 only for an unknown route.
  const cases: [string, string][] = [
    ['product=PF_XBTUSD', 'invalid_interval'],
    ['product=PF_NOPE&interval=1m', 'invalid_product'],
    ['product=PF_XBTUSD&interval=1m&limit=1501', 'invalid_limit'],
    ['product=PF_XBTUSD&interval=1m&from=0', 'range_too_large'],
    ['product=PF_XBTUSD&interval=1m&from=9&to=3', 'invalid_range'],
  ]
  for (const [qs, code] of cases) {
    const bad = await request.get(`/api-live/observability/candles?${qs}`)
    expect([qs, bad.status()]).toEqual([qs, 400])
    expect(await bad.json()).toEqual({ error: { code } })
  }
  expect(
    (await request.get(`${GATEWAY}/api/observability/velas`)).status(),
  ).toBe(404)
})

test('Terminal on the real gateway: every interaction answers without 404', async ({
  page,
}) => {
  const log: { method: string; url: string; status: number }[] = []
  page.on('response', (response) => {
    const url = new URL(response.url())
    if (url.pathname.startsWith('/api-'))
      log.push({
        method: response.request().method(),
        url: url.pathname + url.search,
        status: response.status(),
      })
  })

  await page.goto('/terminal')
  await expect(page.getByTestId('activity-panel')).toBeVisible()
  await expect(page.getByTestId('health-indicator')).toBeVisible()
  // B2 really arrived (not the error state of a failed read).
  await expect(page.getByTestId('window-summary')).toContainText('evaluaciones')
  await expect(page.getByText('No se pudo leer la actividad')).toHaveCount(0)

  // Window 24 h and another product.
  await page.getByRole('button', { name: '24 h' }).click()
  await expect(page.getByRole('button', { name: '24 h' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await page.getByRole('combobox').first().selectOption('PF_ETHUSD')
  await expect(page.getByTestId('activity-panel')).toContainText('ETH')

  // Health inspector: open and close.
  await page.getByTestId('health-indicator').click()
  const dialog = page.getByRole('dialog', { name: 'Salud del sistema' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('heading', { level: 3 })).not.toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  // Chart controls.
  await page.getByRole('button', { name: '5m', exact: true }).click()
  await expect(
    page.getByRole('button', { name: '5m', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true')
  await page.getByText('Indicadores y paneles').click()
  await page.getByRole('checkbox', { name: 'Interés abierto' }).check()
  await page.getByText('Más datos del mercado').click()

  // Decisions list: pick a row when the gateway served analyses.
  const rows = page.locator('.connected-terminal__decision-list li button')
  if ((await rows.count()) > 0) await rows.first().click()

  // Terminal <-> Estrategias.
  await page.getByRole('link', { name: 'Estrategias' }).click()
  await expect(page).toHaveURL(/estrategias/)
  await page.getByRole('link', { name: 'Terminal', exact: true }).click()
  await expect(page.getByTestId('activity-panel')).toBeVisible()

  mkdirSync('playwright-artifacts/integracion-gateway', { recursive: true })
  writeFileSync(
    join('playwright-artifacts/integracion-gateway', 'solicitudes.json'),
    JSON.stringify(log, null, 2),
  )
  // No route may be unknown to its server, anywhere.
  const notFound = log.filter((entry) => entry.status === 404)
  expect(notFound, JSON.stringify(notFound, null, 2)).toEqual([])
  // Everything the Terminal reads from the gateway under test answers.
  const liveFailed = log.filter(
    (entry) => entry.url.startsWith('/api-live/') && entry.status >= 400,
  )
  expect(liveFailed, JSON.stringify(liveFailed, null, 2)).toEqual([])
  // Other services (strategy registry S, MOCK) are not started in this
  // isolation: their connection failures are recorded in the log, not hidden.
  const otherFailed = log.filter(
    (entry) => !entry.url.startsWith('/api-live/') && entry.status >= 400,
  )
  test.info().annotations.push({
    type: 'servicios no levantados',
    description: JSON.stringify(
      otherFailed.map((e) => `${e.method} ${e.url} ${e.status}`),
    ),
  })
  // The observability reads really went out on the corrected paths.
  expect(
    log.some((e) => e.url.startsWith('/api-live/observability/health')),
  ).toBe(true)
  expect(
    log.some((e) => e.url.includes('/observability/activity?window=24h')),
  ).toBe(true)
})

test('B3 answers through the Vite proxy: list, pages, trace and 400s', async ({
  request,
}) => {
  const list = await request.get(
    '/api-live/observability/decisions?product=PF_XBTUSD&limit=50',
  )
  expect(list.status()).toBe(200)
  const body = await list.json()
  expect(body.schema).toBe('observability-decisions.v1')
  expect(body.decisions.state).toBe('ok')
  expect(body.decisions.items).toHaveLength(50)
  expect(body.decisions.range_total).toBe(120)
  expect(body.decisions.next_cursor).not.toBeNull()
  // The next page continues from the cursor and never repeats a row.
  const next = await request.get(
    `/api-live/observability/decisions?product=PF_XBTUSD&limit=50&from=${body.from_ms}&to=${body.to_ms}&cursor=${body.decisions.next_cursor}`,
  )
  expect(next.status()).toBe(200)
  const page2 = (await next.json()).decisions.items
  expect(page2[0].bucket_start_ms).toBeLessThan(
    body.decisions.items.at(-1).bucket_start_ms,
  )
  const trace = await request.get(
    `/api-live/observability/decisions/PF_XBTUSD/${body.decisions.items[0].bucket_start_ms}`,
  )
  expect(trace.status()).toBe(200)
  const traced = await trace.json()
  expect(traced.state).toBe('ok')
  expect(traced.payload_state).toBe('ok')
  expect(traced.payload.proposals.length).toBeGreaterThan(0)
  // Model rows join by (product, bucket): this minute has none, the LONG has one.
  expect(traced.model_decisions.state).toBe('ok')
  expect(traced.model_decisions.items).toEqual([])
  // Bad requests are 400 with a code, never a 404 (that means «route unknown»).
  for (const [url, code] of [
    ['/api-live/observability/decisions', 'invalid_product'],
    [
      '/api-live/observability/decisions?product=PF_XBTUSD&limit=9999',
      'invalid_limit',
    ],
    ['/api-live/observability/decisions/PF_XBTUSD/abc', 'invalid_bucket'],
  ] as const) {
    const res = await request.get(url)
    expect(res.status(), url).toBe(400)
    expect((await res.json()).error.code).toBe(code)
  }
})

test('Investigación de decisiones: HISTORIAL -> list -> trace on the real gateway', async ({
  page,
}) => {
  const log: { method: string; url: string; status: number }[] = []
  page.on('response', (response) => {
    const url = new URL(response.url())
    if (url.pathname.startsWith('/api-'))
      log.push({
        method: response.request().method(),
        url: url.pathname + url.search,
        status: response.status(),
      })
  })
  // Everything the page shows comes from synthetic verdicts: say so on screen.
  const label = async () =>
    page.evaluate(() => {
      document.getElementById('datos-de-ejemplo')?.remove()
      const tag = document.createElement('div')
      tag.id = 'datos-de-ejemplo'
      tag.textContent =
        'DATOS DE EJEMPLO · veredictos sintéticos en una base temporal, no del motor'
      tag.style.cssText =
        'position:fixed;left:12px;bottom:10px;z-index:99;padding:4px 10px;border:1px solid #f59e0b;border-radius:4px;background:#0a0d14;color:#f59e0b;font:600 11px Inter,sans-serif;letter-spacing:.06em'
      document.body.append(tag)
    })

  await page.goto('/terminal')
  await expect(page.getByTestId('activity-panel')).toBeVisible()
  await page.getByTestId('open-investigation').scrollIntoViewIfNeeded()
  mkdirSync('docs/mission-control/b3', { recursive: true })
  await label()
  await page.screenshot({
    path: 'docs/mission-control/b3/captura-terminal-historial-1440x900.png',
  })
  await page.getByTestId('open-investigation').click()
  await expect(page).toHaveURL(/\/investigacion\?product=PF_XBTUSD/)
  await expect(page.getByTestId('investigation')).toBeVisible()
  // No navigation tab was added: the Terminal stays the current page.
  await expect(
    page.getByRole('link', { name: 'Terminal', exact: true }),
  ).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('navigation')).not.toContainText('Investigación')

  const list = page.getByTestId('decision-list')
  await expect(list).toBeVisible()
  await expect(page.getByTestId('list-count')).toContainText(
    'Mostrando 50 de 120',
  )
  // The newest verdict opens its trace, with the six stages.
  await expect(page.getByTestId('stage-6')).toBeVisible()
  await expect(page.getByTestId('proposals')).toContainText(
    'c25-pullback-perp-v1',
  )
  await expect(page.getByTestId('card-action')).toContainText('WAIT')
  await expect(page.getByTestId('reason-origin')).toContainText(
    'no lo atribuye a ninguna estrategia',
  )

  // Second page by cursor.
  await page.getByRole('button', { name: 'Cargar más antiguos' }).click()
  await expect(page.getByTestId('list-count')).toContainText(
    'Mostrando 100 de 120',
  )

  // Filter to the proposal: its row names the strategy the payload names.
  await page.getByRole('button', { name: /^LONG/ }).click()
  await expect(page.getByTestId('list-count')).toContainText('Mostrando 1 de 1')
  await expect(list).toContainText('c25_long_pullback')
  await expect(list).toContainText('c25-pullback-perp-v1')
  await expect(page.getByTestId('card-action')).toContainText(
    'LONG (propuesta)',
  )
  await expect(page.getByTestId('stage-4')).toContainText('99.47')
  await expect(page.getByTestId('model-rows')).toContainText('LONG')
  await expect(page.getByTestId('model-rows')).toContainText('confianza 0.62')
  await expect(page.getByTestId('stage-6')).toContainText('No disponible')

  mkdirSync('docs/mission-control/b3', { recursive: true })
  await label()
  await page.screenshot({
    path: 'docs/mission-control/b3/captura-propuesta-1440x900.png',
  })

  // The lower stages of the same trace (selector, model rows, final, paper).
  await page
    .getByTestId('trace-panel')
    .evaluate((el) => el.scrollTo(0, el.scrollHeight))
  await page.screenshot({
    path: 'docs/mission-control/b3/captura-propuesta-etapas-1440x900.png',
  })
  await page.getByTestId('trace-panel').evaluate((el) => el.scrollTo(0, 0))

  // Back to everything, filter by a clicked reason and clear it.
  await page.getByRole('button', { name: /^Todos/ }).click()
  await expect(page.getByTestId('list-count')).toContainText('de 120')
  await page.getByTitle('Filtrar por este motivo').first().click()
  await expect(page.getByTestId('reason-filter')).toContainText(
    'no_directional_proposal',
  )
  await page.getByRole('button', { name: 'Quitar el filtro de motivo' }).click()
  await expect(page.getByTestId('reason-filter')).toHaveCount(0)
  // A discard: its reason is the selector's, attributed to no strategy.
  await page.getByRole('button', { name: /^WAIT/ }).click()
  await page
    .getByTestId('decision-list')
    .getByRole('button', { name: /UTC$/ })
    .nth(2)
    .click()
  await expect(page.getByTestId('card-action')).toContainText('WAIT')
  await expect(page.getByTestId('stage-3')).toContainText(
    'el payload no lo atribuye a ninguna estrategia',
  )
  await label()
  await page.screenshot({
    path: 'docs/mission-control/b3/captura-descarte-1440x900.png',
  })

  // Another product, and the way back.
  await page
    .getByLabel('Producto de la investigación')
    .selectOption('PF_ETHUSD')
  await expect(page.getByTestId('list-count')).toContainText('de 30')
  await page.getByRole('link', { name: 'Volver a la Terminal' }).click()
  await expect(page.getByTestId('activity-panel')).toBeVisible()

  const failed = log.filter((entry) => entry.status >= 400)
  expect(failed, JSON.stringify(failed, null, 2)).toEqual([])
  expect(log.some((e) => e.url.includes('/observability/decisions?'))).toBe(
    true,
  )
  expect(
    log.some((e) => /\/observability\/decisions\/PF_XBTUSD\/\d+$/.test(e.url)),
  ).toBe(true)
})
