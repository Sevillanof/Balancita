import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

/*
 * Integration with the REAL servers: no route mocks. The gateway runs from
 * `gateway-main.ts` on the dev "live" port and the strategy registry S (Python,
 * `futures_strategy_registry`) on its dev port, both with throwaway databases
 * (synthetic fixture data under a temp folder, DATOS DE EJEMPLO). Vite proxies
 * `/api-live` and `/api-strategies` to them and the browser talks to Vite. A
 * 404/502 here means frontend and server disagree on a route or a service is
 * missing, which the mocked specs cannot see. The last test stops S and checks
 * that Estrategias says so instead of showing anything as valid.
 */
const LIVE_PORT = 8789
const STRATEGIES_PORT = 8790
const GATEWAY = `http://127.0.0.1:${LIVE_PORT}`
const REGISTRY = `http://127.0.0.1:${STRATEGIES_PORT}`

let gateway: ChildProcess | null = null
let registry: ChildProcess | null = null

type Logged = { method: string; url: string; status: number }

function recordApi(page: Page): Logged[] {
  const log: Logged[] = []
  page.on('response', (response) => {
    const url = new URL(response.url())
    if (url.pathname.startsWith('/api-'))
      log.push({
        method: response.request().method(),
        url: url.pathname + url.search,
        status: response.status(),
      })
  })
  return log
}

function saveLog(name: string, log: Logged[]) {
  mkdirSync('playwright-artifacts/integracion-gateway', { recursive: true })
  writeFileSync(
    join('playwright-artifacts/integracion-gateway', name),
    JSON.stringify(log, null, 2),
  )
}

async function waitFor(url: string, what: string, tail: () => string) {
  const deadline = Date.now() + 20_000
  for (;;) {
    try {
      if ((await fetch(url)).ok) return
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline)
      throw new Error(`${what} did not start: ${tail().slice(-800)}`)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

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
  const dir = env.dir as string
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
  // Registry S: real Python, temporary strategies DB, synthetic candles and
  // verdicts (DATOS DE EJEMPLO), carry folder inside the temp dir.
  const pythonPath = join(process.cwd(), 'python')
  const registryDbs = JSON.parse(
    execFileSync('python3', ['e2e/support/seed_registry_sandbox.py', dir], {
      encoding: 'utf8',
      env: { ...process.env, PYTHONPATH: pythonPath },
    }).trim(),
  ) as { verdicts_db: string; market_db: string }
  registry = spawn(
    'python3',
    [
      '-m',
      'balancita_engine.futures_strategy_registry',
      '--strategies-db',
      join(dir, 'futures-strategies.sqlite'),
      '--verdicts-db',
      registryDbs.verdicts_db,
      '--market-db',
      registryDbs.market_db,
      '--port',
      String(STRATEGIES_PORT),
    ],
    {
      env: {
        ...process.env,
        PYTHONPATH: pythonPath,
        CARRY_DIR: join(dir, 'carry'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let registryLog = ''
  registry.stdout?.on('data', (chunk) => (registryLog += String(chunk)))
  registry.stderr?.on('data', (chunk) => (registryLog += String(chunk)))
  await waitFor(
    `${GATEWAY}/api/observability/health`,
    'the gateway',
    () => stderr,
  )
  await waitFor(
    `${REGISTRY}/api-strategies/health`,
    'the strategy registry',
    () => registryLog,
  )
})

test.afterAll(() => {
  gateway?.kill('SIGTERM')
  registry?.kill('SIGTERM')
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
  const log = recordApi(page)

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

  // Terminal <-> Estrategias (registry S is up in this run).
  await page.getByRole('link', { name: 'Estrategias' }).click()
  await expect(page).toHaveURL(/estrategias/)
  // Estrategias opens on the inventory (read from the real registry S).
  await expect(
    page.getByRole('heading', {
      name: 'Inventario de modelos y calificación estadística',
    }),
  ).toBeVisible()
  // inventory -> laboratory -> inventory -> detail of a strategy -> Terminal.
  await page.getByRole('tab', { name: 'Laboratorio' }).click()
  await expect(page.getByText('Registro de estrategias ·')).toBeVisible()
  await page.getByRole('tab', { name: 'Inventario de modelos' }).click()
  await page
    .getByRole('button', { name: /Detalle de/ })
    .first()
    .click()
  await expect(page.getByRole('tab', { name: 'Laboratorio' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await page.getByRole('link', { name: 'Terminal', exact: true }).click()
  await expect(page.getByTestId('activity-panel')).toBeVisible()

  saveLog('solicitudes-terminal.json', log)
  // With every service up, nothing may answer 4xx/5xx and nothing may touch MOCK.
  const failed = log.filter((entry) => entry.status >= 400)
  expect(failed, JSON.stringify(failed, null, 2)).toEqual([])
  expect(log.filter((entry) => entry.url.startsWith('/api-mock'))).toEqual([])
  // The observability reads really went out on the corrected paths.
  expect(
    log.some((e) => e.url.startsWith('/api-live/observability/health')),
  ).toBe(true)
  expect(
    log.some((e) => e.url.includes('/observability/activity?window=24h')),
  ).toBe(true)
})

test('Estrategias on the real registry S: list, detail, period, new-strategy modal', async ({
  page,
  request,
}) => {
  const log = recordApi(page)
  const count = async () =>
    (await (await request.get('/api-strategies/strategies')).json()).strategies
      .length as number
  const before = await count()

  await page.goto('/estrategias')
  await page.getByRole('tab', { name: 'Laboratorio' }).click()
  await expect(page.getByText('Registro de estrategias ·')).toBeVisible()
  await expect(
    page.getByText('Registro de estrategias no disponible'),
  ).toHaveCount(0)
  // List: the registry's seeded strategy is a row; picking it loads its detail.
  const row = page.getByText('Momentum logarítmico lento').first()
  await expect(row).toBeVisible()
  await row.click()
  // Period selector issues real backtests.
  await page.getByRole('button', { name: '90 d' }).click()
  await expect(page.getByRole('button', { name: '90 d' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  // The Carry panel renders from the registry's own read.
  await expect(page.getByLabel('Carry de funding')).toBeVisible()

  // «Nueva estrategia»: the JSON goes to the real registry as a DRAFT of the
  // throwaway DB (the «operar en paper ya» box is unchecked: nothing runs).
  await page.getByRole('button', { name: 'Nueva estrategia' }).click()
  const dialog = page.getByRole('dialog', { name: 'Nueva estrategia' })
  const spec = JSON.parse(
    readFileSync('config/strategies/c30-momentum-12h-perp-v1.json', 'utf8'),
  )
  spec.id = 'e2e-ejemplo-borrador'
  spec.name = 'E2E ejemplo borrador'
  spec.params.z_min = '2.6' // a distinct spec: the registry refuses duplicates
  await dialog.getByRole('textbox').fill(JSON.stringify(spec))
  await dialog.getByRole('checkbox').uncheck()
  await dialog.getByRole('button', { name: 'Agregar estrategia' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('status').first()).toContainText('borrador')
  expect(await count()).toBe(before + 1)
  const saved = await (
    await request.get('/api-strategies/strategies/e2e-ejemplo-borrador')
  ).json()
  expect(saved.state).toBe('draft')

  // A broken JSON is refused with a visible error and saves nothing.
  await page.getByRole('button', { name: 'Nueva estrategia' }).click()
  await dialog.getByRole('textbox').fill('{ esto no es JSON')
  await dialog.getByRole('button', { name: 'Agregar estrategia' }).click()
  await expect(dialog.getByRole('alert')).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancelar' }).click()
  await expect(dialog).toBeHidden()
  expect(await count()).toBe(before + 1)

  saveLog('solicitudes-estrategias.json', log)
  const failed = log.filter((entry) => entry.status >= 400)
  expect(failed, JSON.stringify(failed, null, 2)).toEqual([])
  expect(log.filter((entry) => entry.url.startsWith('/api-mock'))).toEqual([])
})

test('Estrategias with the registry stopped: honest state, no Carry spam', async ({
  page,
}) => {
  const stopped = registry
  registry = null
  stopped?.kill('SIGTERM')
  await new Promise((resolve) => stopped?.once('exit', resolve))
  const log = recordApi(page)

  await page.goto('/estrategias')
  // The inventory (default view) and the laboratory both say it.
  await expect(page.getByText('No se pudo leer el inventario')).toBeVisible()
  await expect(page.getByText(/servicio sin iniciar/).first()).toBeVisible()
  await page.getByRole('tab', { name: 'Laboratorio' }).click()
  await expect(
    page
      .getByText('Registro de estrategias no disponible: servicio sin iniciar')
      .first(),
  ).toBeVisible()
  await expect(page.getByRole('alert').first()).toContainText(
    'servicio sin iniciar',
  )
  // Nothing is presented as valid: no Carry panel, no ranking.
  await expect(page.getByLabel('Carry de funding')).toHaveCount(0)
  await expect(page.getByText('Momentum logarítmico lento')).toHaveCount(0)
  await page.waitForTimeout(1500)

  saveLog('solicitudes-registro-apagado.json', log)
  const strategies = log.filter((e) => e.url.startsWith('/api-strategies'))
  // One health probe, nothing else (no carry, no ranking, no retries).
  expect(strategies.map((e) => `${e.method} ${e.url}`)).toEqual([
    'GET /api-strategies/health',
  ])
  expect(log.filter((e) => e.url.startsWith('/api-mock'))).toEqual([])
  expect(
    log.filter((e) => e.url.startsWith('/api-live/') && e.status >= 400),
  ).toEqual([])
})
