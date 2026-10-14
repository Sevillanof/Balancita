import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

/*
 * Integration with the REAL strategy registry S, no route mocks (temp
 * strategies DB, read-only COPY of the repo's config/ folder). Vite proxies
 * /api-strategies to it; the gateway is covered by integracion-gateway.pw.ts
 * (its /api-live calls fail here and are not judged). The registry states come from seeding
 * the temp DB, not from the Mac's real registry: captures say so.
 * Fixed ports (8790, 5174): run under `flock /tmp/balancita-e2e.lock`.
 */
const REGISTRY_PORT = 8790
const LIVE_PORT = 8789
const SHOTS =
  process.env.INVENTORY_SHOTS_DIR ?? 'playwright-artifacts/inventario'
const DETAIL_SHOTS =
  process.env.DETAIL_SHOTS_DIR ?? 'playwright-artifacts/detalle-c29'
const SANDBOX_NOTE =
  'DATOS DE EJEMPLO · SANDBOX · config/ real copiada (solo lectura) + base temporal del registro · estados de registro sembrados, no los de la Mac'

let registry: ChildProcess | null = null
let gateway: ChildProcess | null = null
let configCopy = ''

test.describe.configure({ mode: 'serial' })

async function waitFor(url: string, child: ChildProcess, what: string) {
  let stderr = ''
  child.stderr?.on('data', (chunk) => (stderr += String(chunk)))
  const deadline = Date.now() + 25_000
  for (;;) {
    try {
      if ((await fetch(url)).ok) return
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline)
      throw new Error(`${what} did not start: ${stderr.slice(-800)}`)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

// Playwright needs the destructured first argument even when it is empty.
// eslint-disable-next-line no-empty-pattern
test.beforeAll(async ({}, info) => {
  test.skip(
    info.project.name !== 'desktop-1440x900',
    'one project only: the servers own fixed ports',
  )
  const box = mkdtempSync(join(tmpdir(), 'balancita-inventory-'))
  configCopy = join(box, 'config')
  cpSync('config', configCopy, { recursive: true })
  writeFileSync(
    join(box, 'LEEME.txt'),
    'Sandbox de prueba: copia de solo lectura de config/ y una base temporal del registro.\n',
  )
  registry = spawn(
    'python3',
    [
      '-m',
      'balancita_engine.futures_strategy_registry',
      '--strategies-db',
      join(box, 'strategies.sqlite'),
      '--config-dir',
      configCopy,
      '--port',
      String(REGISTRY_PORT),
    ],
    {
      env: {
        ...process.env,
        PYTHONPATH: 'python',
        CARRY_DIR: join(box, 'carry'),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  )
  await waitFor(
    `http://127.0.0.1:${REGISTRY_PORT}/api-strategies/health`,
    registry,
    'the registry',
  )
  // The real gateway (synthetic sandbox DBs) answers B2 for the detail view.
  const seeded = JSON.parse(
    execFileSync('node', ['e2e/support/seed-gateway-sandbox.ts'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim(),
  ) as Record<string, string>
  delete seeded.dir
  gateway = spawn('node', ['server/src/app/gateway-main.ts'], {
    env: {
      ...process.env,
      ...seeded,
      HOST: '127.0.0.1',
      PORT: String(LIVE_PORT),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  await waitFor(
    `http://127.0.0.1:${LIVE_PORT}/api/observability/health`,
    gateway,
    'the gateway',
  )
})

test.afterAll(() => {
  registry?.kill('SIGTERM')
  gateway?.kill('SIGTERM')
})

async function shot(page: Page, name: string, dir = SHOTS, fullPage = true) {
  mkdirSync(dir, { recursive: true })
  await page.evaluate((note) => {
    document.getElementById('sandbox-note')?.remove()
    const bar = document.createElement('div')
    bar.id = 'sandbox-note'
    bar.textContent = note
    bar.style.cssText =
      'padding:4px 8px;font:11px monospace;color:#f59e0b;background:#0a0d14;border-bottom:1px solid #f59e0b;text-align:center'
    document.body.prepend(bar)
  }, SANDBOX_NOTE)
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage })
}

test('GET /api-strategies/inventory answers through the Vite proxy with the real config', async ({
  request,
}) => {
  const response = await request.get('/api-strategies/inventory')
  expect(response.status()).toBe(200)
  const inventory = await response.json()
  expect(inventory.schema).toBe('futures-strategy-inventory.v1')
  const closed = JSON.parse(
    readFileSync(join(configCopy, 'strategy-closed.json'), 'utf8'),
  ) as { ids: string[] }
  const reliability = JSON.parse(
    readFileSync(join(configCopy, 'strategy-reliability.json'), 'utf8'),
  ) as { strategies: Record<string, { verdict: string }> }
  const byId = new Map<
    string,
    { operational: { state: string }; research: { state: string } }
  >(inventory.strategies.map((row: { id: string }) => [row.id, row]))
  for (const id of closed.ids)
    expect(byId.get(id).operational.state).toBe('closed')
  for (const [id, entry] of Object.entries(reliability.strategies))
    expect(byId.get(id).research.state).toBe(entry.verdict)
  // Nothing is written and no forward number exists yet: B5.
  expect(
    inventory.strategies.every(
      (row: { forward: { trades: number | null } }) =>
        row.forward.trades === null,
    ),
  ).toBe(true)
  expect(
    (await request.post('/api-strategies/inventory', { data: {} })).status(),
  ).toBe(404)
})

test('Estrategias opens on the inventory and every interaction answers', async ({
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

  await page.goto('/estrategias')
  await expect(
    page.getByRole('heading', {
      name: 'Inventario de modelos y calificación estadística',
    }),
  ).toBeVisible()
  const rows = page.getByTestId('inventory-row')
  await expect(rows).toHaveCount(10)
  // Same words for both axes; C30 is the only candidate, never "reliable".
  const c30 = page.locator('[data-id="c30-momentum-12h-perp-v1"]')
  await expect(c30.getByTestId('research-badge')).toHaveText(
    'Candidata, no fiable',
  )
  await expect(c30.getByTestId('operational-badge')).toHaveText(
    'Activa en el registro',
  )
  await expect(
    page
      .locator('[data-id="c25-pullback-perp-v1"]')
      .getByTestId('operational-badge'),
  ).toHaveText('Cerrada')
  await expect(
    page
      .locator('[data-id="kronos-small-1h-h4-v1"]')
      .getByTestId('operational-badge'),
  ).toHaveText('Estado no verificado')
  // C31 is registered only in qwen-exit.json: a config does not prove it runs.
  const c31 = page.locator('[data-id^="c31"]')
  await expect(c31.getByTestId('operational-badge')).toHaveText(
    'Estado no verificado',
  )
  await expect(page.getByText('Activa en paper')).toHaveCount(0)
  await expect(page.getByText('Con evidencia de ventaja')).toHaveCount(0)
  await expect(page.getByText('Todas', { exact: false }).first()).toBeVisible()
  await shot(page, '1-inventario')

  // Filters.
  await page.getByRole('button', { name: /Cerradas/ }).click()
  await expect(rows).toHaveCount(4)
  await page.getByRole('button', { name: /Evidencia preliminar/ }).click()
  await expect(rows).toHaveCount(1)
  await page.getByRole('button', { name: /Todas/ }).click()
  await expect(rows).toHaveCount(10)

  // Audit of a closed strategy.
  await page.getByRole('button', { name: /Auditar C25/ }).click()
  await expect(page.getByTestId('inventory-audit')).toContainText(
    'closed_with_engine_d',
  )
  await shot(page, '2-auditoria-cerrada')

  // Detail opens the C29 detail view; the laboratory stays one click away.
  await page.getByRole('button', { name: /Detalle de C29/ }).click()
  await expect(page.getByTestId('strategy-detail')).toBeVisible()
  await page.getByRole('button', { name: 'Abrir en Laboratorio' }).click()
  await expect(
    page.getByRole('heading', { name: /^C29/ }).first(),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Nueva estrategia' }),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Importar' })).toBeVisible()
  await shot(page, '3-laboratorio-c29')
  await page.getByRole('tab', { name: 'Inventario de modelos' }).click()
  await expect(rows).toHaveCount(10)

  // «Ver contador» of the Carry row opens the real counter and returns.
  await page.getByRole('button', { name: /Ver contador de/ }).click()
  await expect(page.getByRole('tab', { name: 'Laboratorio' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  const carryPanel = page.getByRole('region', { name: 'Carry de funding' })
  await expect(carryPanel).toBeVisible()
  await expect(page.getByTestId('carry-destino')).toBeFocused()
  await expect(carryPanel).toBeInViewport()
  await shot(page, '4-contador-carry')
  await page.getByRole('tab', { name: 'Inventario de modelos' }).click()
  await expect(rows).toHaveCount(10)

  mkdirSync(SHOTS, { recursive: true })
  writeFileSync(join(SHOTS, 'solicitudes.json'), JSON.stringify(log, null, 2))
  const inventoryCalls = log.filter((entry) =>
    entry.url.startsWith('/api-strategies/inventory'),
  )
  expect(inventoryCalls.length).toBeGreaterThan(0)
  expect(inventoryCalls.every((entry) => entry.status === 200)).toBe(true)
  const notFound = log.filter(
    (entry) => entry.url.startsWith('/api-strategies/') && entry.status === 404,
  )
  expect(notFound, JSON.stringify(notFound, null, 2)).toEqual([])
  const failed = log.filter(
    (entry) => entry.url.startsWith('/api-strategies/') && entry.status >= 500,
  )
  expect(failed, JSON.stringify(failed, null, 2)).toEqual([])
})

test('navigation: Terminal <-> Estrategias <-> inventory <-> detail, no new tabs', async ({
  page,
}) => {
  await page.route('**/api-live/**', (route) =>
    route.fulfill({ status: 503, json: {} }),
  )
  // The Terminal side of the round trip (with its own navigation) is covered
  // against the real gateway in integracion-gateway.pw.ts.
  await page.goto('/estrategias')
  await expect(
    page.getByRole('heading', {
      name: 'Inventario de modelos y calificación estadística',
    }),
  ).toBeVisible()
  await expect(page.getByTestId('inventory-row')).toHaveCount(10)
  // No new tab: the two views of Estrategias are the only ones.
  await expect(page.getByRole('tab')).toHaveText([
    'Inventario de modelos',
    'Laboratorio',
  ])
  // Inventory -> detail of C29 -> back through the breadcrumb.
  await page.getByRole('button', { name: /Detalle de C29/ }).click()
  const detail = page.getByTestId('strategy-detail')
  await expect(detail).toBeVisible()
  await expect(detail.getByRole('heading', { name: /^C29/ })).toBeVisible()
  await expect(
    page.getByRole('tab', { name: 'Inventario de modelos' }),
  ).toHaveAttribute('aria-selected', 'true')
  await detail.getByRole('button', { name: 'Estrategias' }).click()
  await expect(page.getByTestId('inventory-row')).toHaveCount(10)
  // The detail is generic: other rules strategies open the same view, with
  // their own figures and without C29's.
  await page.getByRole('button', { name: /Detalle de C30/ }).click()
  await expect(detail.getByRole('heading', { name: /^C30/ })).toBeVisible()
  await expect(detail.getByTestId('module-performance')).toBeVisible()
  await expect(detail.getByTestId('module-config')).not.toContainText(
    'HASH: ca81f9ce',
  )
  await expect(detail.getByTestId('module-performance')).toContainText(
    'Fuera de muestra (OOS)',
  )
  await detail.getByRole('button', { name: 'Estrategias' }).click()
  // C32 has no backtest by design: «No disponible», not an empty table.
  await page.getByRole('button', { name: /Detalle de C32/ }).click()
  await expect(detail.getByRole('heading', { name: /^C32/ })).toBeVisible()
  await expect(detail.getByTestId('module-performance')).toContainText(
    'no tiene backtest por diseño',
  )
  // Detail of C29 -> general Terminal (no C29 selection) -> back.
  await detail.getByRole('button', { name: 'Estrategias' }).click()
  await page.getByRole('button', { name: /Detalle de C29/ }).click()
  await expect(detail.getByRole('heading', { name: /^C29/ })).toBeVisible()
  await expect(detail.getByText('Ver en Terminal')).toHaveCount(0)
  const toTerminal = detail.getByRole('link', { name: /Abrir la Terminal/ })
  await expect(toTerminal).toHaveAccessibleDescription(
    'Abre la Terminal general; no selecciona el experimento C29.',
  )
  await toTerminal.click()
  await expect(page).toHaveURL(/\/terminal$/)
  expect(new URL(page.url()).search + new URL(page.url()).hash).toBe('')
  await expect(page.getByTestId('strategy-detail')).toHaveCount(0)
  await page.goBack()
  await expect(page).toHaveURL(/\/estrategias$/)
  await expect(page.getByTestId('inventory-row')).toHaveCount(10)
  await page.getByRole('button', { name: /Detalle de C32/ }).click()
  // Detail -> laboratory (explicit action) -> back to the inventory tab.
  await detail.getByRole('button', { name: 'Abrir en Laboratorio' }).click()
  await expect(page.getByRole('tab', { name: 'Laboratorio' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await page.getByRole('tab', { name: 'Inventario de modelos' }).click()
  await expect(page.getByTestId('inventory-row')).toHaveCount(10)
  // Estrategias -> Terminal -> back: opens on the inventory again.
  await page.getByRole('link', { name: 'Terminal', exact: true }).click()
  await expect(page).toHaveURL(/\/terminal$/)
  await page.goBack()
  await expect(page).toHaveURL(/\/estrategias$/)
  await expect(page.getByTestId('inventory-row')).toHaveCount(10)
})

test('Detalle C29 shows the real registry figures, B2 operations and no invented data', async ({
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
  const reliability = JSON.parse(
    readFileSync(join(configCopy, 'strategy-reliability.json'), 'utf8'),
  ) as {
    strategies: Record<
      string,
      {
        trades: number
        mean_net_bp: number
        pnl_usd: number
        t_stat: number
        spec_hash: string
        verdict: string
        by_range: Record<string, { trades: number }>
      }
    >
  }
  const c29 = reliability.strategies['c29-momentum-perp-v1']!

  await page.goto('/estrategias')
  await page.getByRole('button', { name: /Detalle de C29/ }).click()
  const detail = page.getByTestId('strategy-detail')
  await expect(detail).toBeVisible()
  await expect(
    detail.getByRole('heading', { name: /^C29/, level: 2 }),
  ).toBeVisible()
  // Same badges as the inventory.
  await expect(detail.getByTestId('operational-badge')).toHaveText(
    'Activa en el registro',
  )
  await expect(detail.getByTestId('research-badge')).toHaveText(
    'Sin ventaja demostrada',
  )
  await expect(detail.getByTestId('frozen-badge')).toBeVisible()
  // Figures straight from strategy-reliability.json.
  const performance = detail.getByTestId('module-performance')
  await expect(performance).toContainText(`${String(c29.trades)} operaciones`)
  await expect(performance).toContainText('+24,02 pb/op')
  await expect(performance).toContainText('+174,59 USD')
  await expect(performance.getByTestId('range-table')).toContainText(
    String(c29.by_range.previous!.trades),
  )
  // The real ranges last 237 days (first/last bucket), not the 240 of a label.
  await expect(performance).toContainText('2 rangos de 237 d')
  await expect(performance.getByTestId('range-table')).not.toContainText('240')
  // Backtest, out of sample and forward are separate and never mixed.
  await expect(performance.getByTestId('oos-note')).toContainText(
    'No disponible',
  )
  await expect(performance.getByText('Fuente:')).toHaveCount(3)
  await expect(performance.getByTestId('verdict')).toContainText(
    'no es rentabilidad demostrada',
  )
  // Forward: B5, never a number. Pipeline: B3.
  await expect(performance).toContainText('resultados del forward: B5')
  await expect(detail.getByTestId('module-pipeline')).toContainText('B3')
  // Real spec and hash.
  await expect(detail.getByTestId('module-config')).toContainText(
    `HASH: ${c29.spec_hash.slice(0, 8)}`,
  )
  await expect(detail.getByTestId('params-table')).toContainText('sqrt_bars')
  await expect(detail.getByTestId('side-LONG')).toContainText(
    'c29_long_momentum',
  )
  await expect(detail.getByTestId('plan-table')).toContainText('100 USD')
  // B2 answered for real (sandbox forward has no C29 row: said, not invented).
  await expect(detail.getByTestId('module-operations')).not.toContainText(
    'Leyendo operaciones',
  )
  await expect(detail.getByTestId('module-operations')).not.toContainText(
    'no se pudo leer B2',
  )
  expect(await detail.locator('svg, canvas').count()).toBe(0)

  mkdirSync(DETAIL_SHOTS, { recursive: true })
  await shot(page, 'detalle-c29', DETAIL_SHOTS, false)
  await shot(page, 'detalle-c29-completo', DETAIL_SHOTS)
  // Back to the inventory through the breadcrumb.
  await detail.getByRole('button', { name: 'Estrategias' }).click()
  await expect(page.getByTestId('inventory-row')).toHaveCount(10)

  writeFileSync(
    join(DETAIL_SHOTS, 'solicitudes.json'),
    JSON.stringify(log, null, 2),
  )
  const activity = log.filter((entry) =>
    entry.url.startsWith('/api-live/observability/activity'),
  )
  expect(activity.length).toBeGreaterThan(0)
  expect(activity.every((entry) => entry.status === 200)).toBe(true)
  const broken = log.filter(
    (entry) =>
      entry.url.startsWith('/api-strategies/') &&
      (entry.status === 404 || entry.status >= 500),
  )
  expect(broken, JSON.stringify(broken, null, 2)).toEqual([])
})
