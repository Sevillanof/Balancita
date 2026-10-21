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
const SANDBOX_NOTE =
  'DATOS DE EJEMPLO · SANDBOX · config/ real copiada (solo lectura) + base temporal del registro · estados de registro sembrados, no los de la Mac'

let registry: ChildProcess | null = null
let gateway: ChildProcess | null = null
let configCopy = ''
let forwardSummary = ''
const C30 = 'c30-momentum-12h-perp-v1'

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
  forwardSummary = join(box, 'forward-reliability.json')
  registry = spawn(
    'python3',
    [
      '-m',
      'balancita_engine.futures_strategy_registry',
      '--strategies-db',
      join(box, 'strategies.sqlite'),
      '--config-dir',
      configCopy,
      '--forward-summary',
      forwardSummary,
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
  // Hand-written forward summary (DATOS DE EJEMPLO, not a Kraken record): only
  // C30 is measured, with 7 live and 2 recovered closed trades, 15 required.
  // Written after the registry is up because it needs C30's real spec hash.
  const inventory = (await (
    await fetch(`http://127.0.0.1:${REGISTRY_PORT}/api-strategies/inventory`)
  ).json()) as { strategies: { id: string; spec_hash: string }[] }
  const now = Date.now()
  const side = (trades: number, pnl: number) => ({
    trades,
    pnl_usd: pnl,
    mean_net_bp: trades ? 12.5 : null,
    hit_rate: trades ? 0.5 : null,
    funding_incomplete_trades: 0,
    net_is_definitive: true,
  })
  writeFileSync(
    forwardSummary,
    JSON.stringify({
      schema: 'futures-strategy-forward.v1',
      updated_ms: now - 10 * 60_000,
      min_forward_trades: 15,
      strategies: {
        [C30]: {
          spec_hash: inventory.strategies.find((row) => row.id === C30)!
            .spec_hash,
          start_ms: now - 30 * 86_400_000,
          open_positions: 0,
          summary_without_recovered: side(7, 31.5),
          summary_recovered: side(2, -4),
          funding_state: {},
          missing_candles_1m: 0,
          max_candle_lag_ms: 1000,
        },
      },
    }),
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
  // Nothing is written. Only C30 is in the hand-written forward summary: it
  // alone has a result; every other row says why it has none, never a number.
  for (const row of inventory.strategies as {
    id: string
    forward: { trades: { live: { closed: number } } | null; missing: string }
  }[]) {
    if (row.id === C30) expect(row.forward.trades?.live.closed).toBe(7)
    else {
      expect(row.forward.trades).toBeNull()
      expect(row.forward.missing).toBeTruthy()
    }
  }
  expect(
    (await request.post('/api-strategies/inventory', { data: {} })).status(),
  ).toBe(404)
})

test('Estrategias is only the list of names and the last test of the chosen one', async ({
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
  const list = page.getByRole('navigation', { name: 'Lista de estrategias' })
  // Every strategy is in the list, retired ones included (10 + the 6 retired).
  await expect(list.getByRole('button')).toHaveCount(10)
  await expect(list.getByRole('button', { name: /^C27/ })).toBeVisible()
  await expect(page.getByRole('tablist')).toHaveCount(0)

  // The chosen strategy shows its last test: stage bar and the four figures.
  await list.getByRole('button', { name: /^C29/ }).click()
  const view = page.getByTestId('run-view')
  await expect(view).toBeVisible()
  await expect(
    view.getByRole('list', { name: 'Etapa de la estrategia' }),
  ).toBeVisible()
  await expect(view.getByTestId('run-kpis')).toBeVisible()
  await list.getByRole('button', { name: /^C27/ }).click()
  await expect(page.getByTestId('run-view')).toHaveAccessibleName(/C27/)
  await shot(page, '1-estrategias')

  // Nothing else is on the screen.
  await expect(page.getByText('Nueva estrategia')).toHaveCount(0)
  await expect(page.getByText('Ver detalles')).toHaveCount(0)
  await expect(page.getByText(/Módulo \d\d/i)).toHaveCount(0)

  mkdirSync(SHOTS, { recursive: true })
  writeFileSync(join(SHOTS, 'solicitudes.json'), JSON.stringify(log, null, 2))
  const bad = log.filter(
    (entry) =>
      entry.url.startsWith('/api-strategies/') &&
      // This sandbox registry runs without a gate database.
      !entry.url.includes('/gate/') &&
      (entry.status === 404 || entry.status >= 500),
  )
  expect(bad, JSON.stringify(bad, null, 2)).toEqual([])
})
