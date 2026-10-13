import { spawn, type ChildProcess } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

/*
 * Experiment comparison against the REAL strategy registry S, no route mocks (temp
 * strategies DB, read-only COPY of the repo's config/ folder). Vite proxies
 * /api-strategies to it; the gateway is covered by integracion-gateway.pw.ts
 * (its /api-live calls fail here and are not judged). The registry states come from seeding
 * the temp DB, not from the Mac's real registry: captures say so.
 * Fixed ports (8790, 5174): run under `flock /tmp/balancita-e2e.lock`.
 */
const REGISTRY_PORT = 8790
const SHOTS =
  process.env.COMPARISON_SHOTS_DIR ?? 'playwright-artifacts/comparacion'
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
  const box = mkdtempSync(join(tmpdir(), 'balancita-comparison-'))
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

// Wait for the exit: the next spec reuses port 8790 and must not find this one.
test.afterAll(async () => {
  const child = registry
  if (!child || child.exitCode !== null) return
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.kill('SIGTERM')
  await exited
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

test('Ver comparación shows one separate book per experiment from the real registry', async ({
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
  await expect(page.getByTestId('inventory-row')).toHaveCount(10)
  // The switch lives inside the page: the app navigation gains no entry.
  await expect(page.getByRole('tab')).toHaveCount(2)
  await page.getByRole('button', { name: 'Ver comparación' }).click()
  await expect(
    page.getByRole('heading', { name: 'Un libro paper por experimento' }),
  ).toBeVisible()
  const cards = page.getByTestId('experiment-card')
  await expect(cards).toHaveCount(10)
  await expect(page.getByTestId('running-count')).toHaveText('5')
  await expect(page.getByTestId('stopped-count')).toHaveText('5')
  await expect(page.getByRole('note')).toContainText('no se suman')

  const card = (id: string) => page.locator(`[data-id="${id}"]`)
  // The same badges as the inventory, on both axes.
  await expect(
    card('c30-momentum-12h-perp-v1').getByTestId('research-badge'),
  ).toHaveText('Candidata, no fiable')
  await expect(
    card('c30-momentum-12h-perp-v1').getByTestId('operational-badge'),
  ).toHaveText('Activa en paper')
  // Kronos has no source for its state; Carry keeps the registry's state.
  await expect(
    card('kronos-small-1h-h4-v1').getByTestId('operational-badge'),
  ).toHaveText('Estado no verificado')
  await expect(
    card('carry-funding-c-v1').getByTestId('operational-badge'),
  ).toHaveText('Estado no verificado')
  await expect(card('carry-funding-c-v1')).not.toContainText('descartad')
  await expect(
    card('c25-pullback-perp-v1').getByTestId('operational-badge'),
  ).toHaveText('Cerrada')
  // No forward result without a source (B5), no terminal buttons, no sums.
  for (const text of await cards.allTextContents())
    expect(text).toContain('No disponible (B5)')
  await expect(page.getByText('Abrir en Terminal')).toHaveCount(0)
  await expect(page.getByText(/rentable/i)).toHaveCount(0)
  await shot(page, '1-comparacion')

  // Detail opens the laboratory; back to the inventory keeps working.
  await page.getByRole('button', { name: /Detalle de C29/ }).click()
  await expect(
    page.getByRole('heading', { name: /^C29/ }).first(),
  ).toBeVisible()
  await page.getByRole('tab', { name: 'Inventario de modelos' }).click()
  await page.getByRole('button', { name: 'Ver comparación' }).click()
  await page.getByRole('button', { name: '← Volver al inventario' }).click()
  await expect(page.getByTestId('inventory-row')).toHaveCount(10)

  mkdirSync(SHOTS, { recursive: true })
  writeFileSync(join(SHOTS, 'solicitudes.json'), JSON.stringify(log, null, 2))
  const bad = log.filter(
    (entry) =>
      entry.url.startsWith('/api-strategies/') &&
      (entry.status === 404 || entry.status >= 500),
  )
  expect(bad, JSON.stringify(bad, null, 2)).toEqual([])
  const inventoryCalls = log.filter((entry) =>
    entry.url.startsWith('/api-strategies/inventory'),
  )
  expect(inventoryCalls.length).toBeGreaterThan(1)
  expect(inventoryCalls.every((entry) => entry.status === 200)).toBe(true)
})
