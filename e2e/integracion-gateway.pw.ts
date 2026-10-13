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

test.describe.configure({ mode: 'serial' })

// Playwright needs the destructured first argument even when it is empty.
// eslint-disable-next-line no-empty-pattern
test.beforeAll(async ({}, info) => {
  test.skip(
    info.project.name !== 'desktop-1440x900',
    'one project only: the gateway owns a fixed port',
  )
  const env = JSON.parse(
    execFileSync('node', ['e2e/support/seed-gateway-sandbox.ts'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim(),
  ) as Record<string, string>
  delete env.dir // the seed prints its folder; the gateway does not need it
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
