import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

/*
 * JOINT integration of the three Estrategias views (inventory #156, comparison
 * #158, detail #159) in ONE route, against the REAL registry S (temp strategies
 * DB, read-only COPY of config/) and the REAL gateway (synthetic sandbox DBs).
 * Only the Kronos freshness phases answer the two read-only Kronos routes with
 * rotulated SYNTHETIC figures (status 200). Zero 4xx/5xx and zero /api-mock
 * over the whole path. Registry states come from the temp DB, not the Mac's.
 * Fixed ports (8790, 5174): run under `flock /tmp/balancita-e2e.lock`.
 */
const REGISTRY_PORT = 8790
const LIVE_PORT = 8789
const SHOTS =
  process.env.JOINT_SHOTS_DIR ?? 'playwright-artifacts/integracion-conjunta'
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
  const box = mkdtempSync(join(tmpdir(), 'balancita-joint-'))
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

type Logged = { method: string; url: string; status: number }

function synthScores(updated: number, stampOffset = 0) {
  // DATOS SINTÉTICOS (sandbox): one product with one stamped decision and trade.
  return {
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
            bucket_start: updated - 3_600_000 + stampOffset,
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
            exit_time_ms: updated - 3_600_000 + stampOffset,
            exit_price: '100.4',
            exit_reason: 'horizon',
            net_bp: 12,
            pnl_usd: 0.4,
          },
        ],
      },
    ],
  }
}

async function kronosRoutes(page: Page, system: unknown, scores: unknown) {
  await page.route('**/api-live/system', (route) =>
    route.fulfill({ json: system }),
  )
  await page.route('**/api-live/kronos/scores*', (route) =>
    route.fulfill({ json: scores }),
  )
}

test('Terminal -> strategies page -> Carry -> C29 detail -> Kronos, one route', async ({
  page,
}) => {
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
  const cards = page.getByTestId('experiment-card')
  const kronos = page.locator('[data-id="kronos-small-1h-h4-v1"]')

  // 1. Terminal -> Estrategias opens on the strategies page, no tabs.
  await page.goto('/terminal')
  await expect(page.getByTestId('activity-panel')).toBeVisible()
  await page.getByRole('link', { name: 'Estrategias' }).click()
  await expect(page).toHaveURL(/\/estrategias$/)
  await expect(cards).toHaveCount(4)
  await expect(page.getByRole('tablist')).toHaveCount(0)
  await expect(page.getByTestId('retired-row')).toHaveCount(6)
  await shot(page, '1-estrategias')

  // 2. «Ver contador de Carry»: Laboratory, focus on the Carry panel, back.
  await page.getByRole('button', { name: /Ver contador de/ }).click()
  await expect(page.getByRole('heading', { name: 'Laboratorio' })).toBeVisible()
  const carryPanel = page.getByRole('region', { name: 'Carry de funding' })
  await expect(carryPanel).toBeVisible()
  await expect(page.getByTestId('carry-destino')).toBeFocused()
  await expect(carryPanel).toBeInViewport()
  await shot(page, '2-contador-carry')
  await page.getByRole('button', { name: '← Estrategias' }).click()
  await expect(cards).toHaveCount(4)

  // 3. C29 detail: 237 days, three evidence kinds apart, Terminal = general.
  await page.getByRole('button', { name: /Detalle de C29/ }).click()
  const detail = page.getByTestId('strategy-detail')
  await expect(detail.getByRole('heading', { name: /^C29/ })).toBeVisible()
  const performance = detail.getByTestId('module-performance')
  await expect(performance).toContainText('2 rangos de 237 d')
  await expect(performance.getByTestId('range-table')).not.toContainText('240')
  await expect(performance.getByTestId('oos-note')).toContainText(
    'No disponible',
  )
  await expect(performance.getByText('Fuente:')).toHaveCount(3)
  await expect(performance).toContainText(
    'resultados del forward: el servicio no tiene configurada la lectura del forward',
  )
  await expect(detail.getByTestId('module-operations')).not.toContainText(
    'no se pudo leer B2',
  )
  await shot(page, '3-detalle-c29')
  const toTerminal = detail.getByRole('link', { name: /Abrir la Terminal/ })
  await expect(toTerminal).toHaveAccessibleDescription(
    'Abre la Terminal general; no selecciona el experimento C29.',
  )
  await toTerminal.click()
  await expect(page).toHaveURL(/\/terminal$/)
  expect(new URL(page.url()).search + new URL(page.url()).hash).toBe('')
  await expect(page.getByTestId('activity-panel')).toBeVisible()
  await page.goBack()
  await expect(page).toHaveURL(/\/estrategias$/)
  await expect(cards).toHaveCount(4)

  // 4. Detail again, back through the breadcrumb, then the comparison.
  await page.getByRole('button', { name: /Detalle de C29/ }).click()
  await expect(detail).toBeVisible()
  await detail.getByRole('button', { name: 'Estrategias' }).click()
  await expect(cards).toHaveCount(4)
  await expect(
    page.getByRole('heading', { name: 'Un libro paper por estrategia' }),
  ).toBeVisible()
  await expect(page.getByText(/Brazo/i)).toHaveCount(0)
  await expect(page.getByRole('note')).toContainText('no se suman')
  await page.getByText('Qué mide cada estrategia').click()
  const unitRow = (name: RegExp) =>
    page.getByRole('row').filter({ hasText: name })
  await expect(unitRow(/C29/)).toContainText('pb por operación (neto)')
  await expect(unitRow(/Kronos/)).toContainText('No disponible')
  await expect(unitRow(/Kronos/)).not.toContainText('pb por operación')

  // 5. Kronos without verifiable gateway evidence: «Estado no verificado».
  await expect(kronos.getByTestId('kronos-activity')).toContainText(
    'Estado no verificado',
  )
  await expect(page.getByText('Actividad reciente registrada')).toHaveCount(0)
  await shot(page, '5-comparacion-kronos-no-verificado')

  // 6. Fresh synthetic summary + scores with evidence: «Actividad reciente».
  const now = Date.now()
  const fresh = {
    kronos: {
      running: true,
      trades: 4,
      decisions: 30,
      updated_ms: now - 600_000,
    },
  }
  await kronosRoutes(page, fresh, synthScores(now - 600_000))
  await page.reload()
  await expect(kronos.getByTestId('kronos-verified')).toHaveText(
    'Actividad reciente registrada',
  )
  await expect(kronos.getByTestId('kronos-activity')).toContainText(
    '4 operaciones · 30 decisiones',
  )
  await expect(page.getByText('Actividad reciente registrada')).toHaveCount(1)
  await shot(page, '6-comparacion-kronos-verificado')

  // 7. Without evidence / future / stale it goes back to unverified.
  const unverified = async (system: unknown, scores: unknown) => {
    await kronosRoutes(page, system, scores)
    await page.reload()
    await expect(kronos.getByTestId('kronos-activity')).toContainText(
      'Estado no verificado',
    )
    await expect(page.getByText('Actividad reciente registrada')).toHaveCount(0)
  }
  await unverified(fresh, { status: 'ok', products: [] })
  await unverified(fresh, synthScores(now - 600_000, 2 * 3_600_000))
  await unverified(
    { kronos: { ...fresh.kronos, updated_ms: now + 3_600_000 } },
    synthScores(now - 600_000),
  )
  await unverified(
    { kronos: { ...fresh.kronos, updated_ms: now - 3 * 3_600_000 } },
    synthScores(now - 600_000),
  )

  // 8. Back to fresh: the Kronos button opens the Laboratory on Kronos, and
  // the earlier Carry request does NOT pull the focus back to the Carry panel.
  await kronosRoutes(page, fresh, synthScores(now - 600_000))
  await page.reload()
  await expect(kronos.getByTestId('kronos-verified')).toBeVisible()
  await kronos
    .getByRole('button', { name: 'Abrir Kronos en el Laboratorio' })
    .click()
  await expect(page.getByRole('heading', { name: 'Laboratorio' })).toBeVisible()
  await expect(
    page.getByRole('button', { name: /Kronos/, pressed: true }).first(),
  ).toBeVisible()
  await expect(page.getByTestId('carry-destino')).not.toBeFocused()
  await shot(page, '8-laboratorio-kronos')

  // 9. Back to the strategies page.
  await page.getByRole('button', { name: '← Estrategias' }).click()
  await expect(cards).toHaveCount(4)

  mkdirSync(SHOTS, { recursive: true })
  writeFileSync(join(SHOTS, 'solicitudes.json'), JSON.stringify(log, null, 2))
  const failed = log.filter((entry) => entry.status >= 400)
  expect(failed, JSON.stringify(failed, null, 2)).toEqual([])
  expect(log.filter((entry) => entry.url.startsWith('/api-mock'))).toEqual([])
  expect(
    log.some((entry) => entry.url.startsWith('/api-strategies/inventory')),
  ).toBe(true)
})

test('a served Carry request does not pull the focus back when the Laboratory is re-entered from the strategies page', async ({
  page,
}) => {
  // Same mounted Estrategias (no Terminal trip in between): the shared
  // navigation state of #156 (carry request) meets #158's Kronos button.
  const failed: string[] = []
  page.on('response', (response) => {
    const url = new URL(response.url())
    if (url.pathname.startsWith('/api-') && response.status() >= 400)
      failed.push(`${response.status()} ${url.pathname}`)
  })
  await page.goto('/estrategias')
  await expect(page.getByTestId('experiment-card')).toHaveCount(4)
  await page.getByRole('button', { name: /Ver contador de/ }).click()
  await expect(page.getByTestId('carry-destino')).toBeFocused()
  await page.getByRole('button', { name: '← Estrategias' }).click()
  await page
    .locator('[data-id="kronos-small-1h-h4-v1"]')
    .getByRole('button', { name: 'Abrir Kronos en el Laboratorio' })
    .click()
  await expect(
    page.getByRole('button', { name: /Kronos/, pressed: true }).first(),
  ).toBeVisible()
  await expect(page.getByTestId('carry-destino')).not.toBeFocused()
  // And entering through «Nueva estrategia» does not re-trigger it either.
  await page.getByRole('button', { name: '← Estrategias' }).click()
  await page.getByRole('button', { name: 'Nueva estrategia' }).click()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('carry-destino')).not.toBeFocused()
  expect(failed).toEqual([])
})
