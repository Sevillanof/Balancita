import { spawn, type ChildProcess } from 'node:child_process'
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
const SHOTS =
  process.env.INVENTORY_SHOTS_DIR ?? 'playwright-artifacts/inventario'
const SANDBOX_NOTE =
  'SANDBOX · config/ real copiada (solo lectura) + base temporal del registro · estados de registro sembrados, no los de la Mac'

let registry: ChildProcess | null = null
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
})

test.afterAll(() => {
  registry?.kill('SIGTERM')
})

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true })
  await page.evaluate((note) => {
    document.getElementById('sandbox-note')?.remove()
    const bar = document.createElement('div')
    bar.id = 'sandbox-note'
    bar.textContent = note
    bar.style.cssText =
      'padding:4px 8px;font:11px monospace;color:#f59e0b;background:#0a0d14;border-bottom:1px solid #f59e0b;text-align:center'
    document.body.prepend(bar)
  }, SANDBOX_NOTE)
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true })
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

  // Detail opens the existing laboratory on that strategy, actions intact.
  await page.getByRole('button', { name: /Detalle de C29/ }).click()
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
