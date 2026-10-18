import { spawn, type ChildProcess } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { OPERATIONAL_LABELS } from '../src/features/strategy-lab/domain/strategy-labels.ts'

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
  'DATOS DE EJEMPLO · SANDBOX · config/ real copiada (solo lectura) + base temporal del registro · estados de registro sembrados, no los de la Mac'

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

test('the strategies page shows one separate book per strategy from the real registry', async ({
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
    page.getByRole('heading', { name: 'Un libro paper por estrategia' }),
  ).toBeVisible()
  // One page: the app navigation and the page gain no tabs.
  await expect(page.getByRole('tablist')).toHaveCount(0)
  const cards = page.getByTestId('experiment-card')
  await expect(cards).toHaveCount(4)
  await expect(page.getByTestId('running-count')).toHaveText('4')
  await expect(page.getByTestId('stopped-count')).toHaveText('6')
  await expect(page.getByRole('note')).toContainText('no se suman')

  const card = (id: string) => page.locator(`[data-id="${id}"]`)
  // The same badges as the inventory, on both axes.
  await expect(
    card('c30-momentum-12h-perp-v1').getByTestId('research-badge'),
  ).toHaveText('Candidata, no fiable')
  await expect(
    card('c30-momentum-12h-perp-v1').getByTestId('operational-badge'),
  ).toHaveText(OPERATIONAL_LABELS.active)
  // Kronos has no source for its state; Carry keeps the registry's state.
  await expect(
    card('kronos-small-1h-h4-v1').getByTestId('operational-badge'),
  ).toHaveText('Estado no verificado')
  await expect(
    card('carry-funding-c-v1').getByTestId('operational-badge'),
  ).toHaveText('Estado no verificado')
  // The gateway is off in this spec: Kronos stays unverified, never inferred.
  await expect(
    card('kronos-small-1h-h4-v1').getByTestId('kronos-activity'),
  ).toContainText('Estado no verificado')
  await expect(page.getByText('Actividad reciente registrada')).toHaveCount(0)
  await expect(page.getByText(/Brazo/i)).toHaveCount(0)
  // Unit per experiment: only where the result is a net bp-per-trade figure.
  await page.getByText('Qué mide cada estrategia').click()
  const unitRow = (name: RegExp) =>
    page.getByRole('row').filter({ hasText: name })
  await expect(unitRow(/Kronos/)).toContainText('No disponible')
  await expect(unitRow(/Kronos/)).not.toContainText('pb por operación')
  await expect(card('carry-funding-c-v1')).not.toContainText('descartad')
  // Closed and turned-off strategies are not cards: they are in the
  // collapsed «Retiradas y apagadas» section.
  await expect(
    cards.and(page.locator('[data-id="c25-pullback-perp-v1"]')),
  ).toHaveCount(0)
  await expect(
    page.getByTestId('retired').locator('[data-id="c25-pullback-perp-v1"]'),
  ).toHaveCount(1)
  // No forward result without a source: each card says why (the registry here
  // runs without --forward-db / --forward-summary), no terminal buttons, no sums.
  // Experiments that are off, closed or not forward-measured by design say so.
  for (const text of await cards.allTextContents()) {
    expect(text).toContain('Forward paper')
    expect(text).not.toContain('cerradas')
  }
  await expect(card('c30-momentum-12h-perp-v1')).toContainText(
    'el servicio no tiene configurada la lectura del forward',
  )
  await expect(page.getByTestId('forward-progress')).toHaveCount(0)
  await expect(page.getByText('Abrir en Terminal')).toHaveCount(0)
  await expect(page.getByText(/rentable/i)).toHaveCount(0)
  await shot(page, '1-comparacion')

  // Detail opens from the card; back to the page keeps working.
  await page.getByRole('button', { name: /Detalle de C29/ }).click()
  await expect(
    page.getByRole('heading', { name: /^C29/ }).first(),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Estrategias' }).click()
  await expect(cards).toHaveCount(4)

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

test('Kronos shows «Actividad reciente registrada» only with a fresh summary and real score evidence', async ({
  page,
}) => {
  // DATOS DE EJEMPLO · SANDBOX: the live gateway is off in this spec, so the two
  // read-only routes are answered here with synthetic figures.
  const updated = Date.now() - 10 * 60_000
  await page.route('**/api-live/system', (route) =>
    route.fulfill({
      json: {
        kronos: {
          running: true,
          trades: 4,
          decisions: 30,
          updated_ms: updated,
        },
      },
    }),
  )
  await page.route('**/api-live/kronos/scores*', (route) =>
    route.fulfill({
      json: {
        status: 'ok',
        products: [
          {
            product_id: 'PF_XBTUSD',
            horizon_min: 240,
            decisions: {
              decisions: 30,
              scored: 28,
              pending: 2,
              hits: 15,
              misses: 13,
              points: 2,
              hit_rate: 0.54,
              mean_net_bp: 1.2,
              total_net_bp: 33.6,
            },
            by_option: {},
            trading: {
              trades: 1,
              wins: 1,
              hit_rate: 1,
              pnl_usd: 0.4,
              return_pct: 0.4,
              max_drawdown: { pct: 0, at_ms: null },
            },
            open_position: null,
            rows: [
              {
                bucket_start: updated - 3_600_000,
                chosen: 'buy',
                confidence: 0.6,
                status: 'scored',
                point: 1,
                net_bp: 12,
              },
            ],
            trades: [
              {
                side: 'LONG',
                entry_time_ms: updated - 7_200_000,
                entry_price: '100.0',
                exit_time_ms: updated - 3_600_000,
                exit_price: '100.4',
                exit_reason: 'horizon',
                net_bp: 12,
                pnl_usd: 0.4,
              },
            ],
          },
        ],
      },
    }),
  )
  await page.goto('/estrategias')
  const kronos = page.locator('[data-id="kronos-small-1h-h4-v1"]')
  await expect(kronos.getByTestId('kronos-verified')).toHaveText(
    'Actividad reciente registrada',
  )
  await expect(kronos.getByTestId('kronos-activity')).toContainText(
    '4 operaciones · 30 decisiones',
  )
  await expect(kronos.getByTestId('kronos-activity')).toContainText(
    'no prueba que el proceso siga corriendo',
  )
  await expect(page.getByText('Actividad reciente registrada')).toHaveCount(1)
  await shot(page, '2-comparacion-kronos-verificado')

  // The button opens the Laboratory on Kronos' own row, not another view.
  await kronos
    .getByRole('button', { name: 'Abrir Kronos en el Laboratorio' })
    .click()
  await expect(page.getByRole('heading', { name: 'Laboratorio' })).toBeVisible()
  await expect(
    page.getByRole('button', { name: /Kronos/, pressed: true }).first(),
  ).toBeVisible()
  await page.getByRole('button', { name: '← Estrategias' }).click()

  // status ok without products is not evidence: back to unverified.
  await page.route('**/api-live/kronos/scores*', (route) =>
    route.fulfill({ json: { status: 'ok', products: [] } }),
  )
  await page.reload()
  await expect(kronos.getByTestId('kronos-activity')).toContainText(
    'Estado no verificado',
  )
  await expect(page.getByText('Actividad reciente registrada')).toHaveCount(0)
})
