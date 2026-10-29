import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

/** The documented examples the backend tests generate from its own code. */
const example = (path: string) =>
  JSON.parse(readFileSync(join('docs/mission-control', path), 'utf8'))

const RUN = 'live-market-view'
const NOW = 1_790_000_000_000
const STEP = 300_000

/** Example candles (a deterministic wave): only the chart's layout is under test. */
function candles(step = STEP) {
  let close = 100_000
  return Array.from({ length: 140 }, (_, i) => {
    const open = close
    close = open + Math.sin(i / 3) * 40 + Math.cos(i / 7) * 25
    return {
      time_ms: NOW - (140 - i) * step,
      open: String(open),
      high: String(Math.max(open, close) + 30),
      low: String(Math.min(open, close) - 30),
      close: String(close),
      volume_btc: '1',
      closed: true,
    }
  })
}

async function openTerminal(page: Page, health: unknown, activity: unknown) {
  // The selected timeframe is 1 m: the example candles are 1 m apart too.
  const series = candles(60_000)
  const bootstrap = {
    schema_version: 1,
    mode: 'paper_live',
    source: 'kraken-public-live-stream.v1',
    active_run_id: RUN,
    products: ['PF_ETHUSD'],
    market: { status: 'live', last_received_at: NOW, funding: 'unknown' },
    engine: {
      status: 'running',
      reason: 'paper_execution_active',
      commands: 'unavailable',
    },
    terminal_market: {
      schema_version: 'futures-terminal-market.v1',
      as_of_ms: NOW,
      interval_ms: 60_000,
      candles: series.slice(-60),
    },
  }
  await page.route('**/api-live/**', (route) =>
    route.fulfill({ status: 503, json: {} }),
  )
  await page.route('**/api-live/terminal/bootstrap**', (route) =>
    route.fulfill({ json: bootstrap }),
  )
  await page.route('**/api-live/terminal/chart**', (route) =>
    route.fulfill({
      json: {
        schema_version: 'futures-terminal-chart.v1',
        interval_ms: Number(
          new URL(route.request().url()).searchParams.get('interval_ms'),
        ),
        candles: candles(
          Number(
            new URL(route.request().url()).searchParams.get('interval_ms'),
          ),
        ),
        flow: [],
      },
    }),
  )
  await page.route('**/api-live/observability/health', (route) =>
    route.fulfill({ json: health }),
  )
  await page.route('**/api-live/observability/activity**', (route) => {
    // The gateway echoes the window and product it was asked for.
    const query = new URL(route.request().url()).searchParams
    const body = activity as {
      evaluations?: { by_product?: Array<{ product: string }> }
    }
    // The examples describe XBT; the Terminal only asks for ETH.
    const evaluations = body.evaluations?.by_product
      ? {
          ...body.evaluations,
          by_product: body.evaluations.by_product.map((row) => ({
            ...row,
            product: query.get('product'),
          })),
        }
      : body.evaluations
    route.fulfill({
      json: {
        ...body,
        evaluations,
        window: query.get('window'),
        product: query.get('product'),
      },
    })
  })
  await page.routeWebSocket(/\/api-live\/terminal\/stream/, (socket) => {
    socket.onMessage(() =>
      socket.send(
        JSON.stringify({
          schema_version: 1,
          event_id: 'event-1',
          stream_id: 'stream-1',
          run_id: RUN,
          seq: 0,
          type: 'snapshot',
          instrument_id: 'kraken-futures:PF_ETHUSD',
          event_time: NOW,
          published_at: NOW,
          data: {
            watermark: 0,
            market: bootstrap.terminal_market,
            state: {
              run_id: RUN,
              state_version: 1,
              analyses: [],
              orders: [],
              fills: [],
              engine: bootstrap.engine,
            },
          },
        }),
      ),
    )
  })
  await page.goto('/terminal')
  await expect(page.getByTestId('activity-panel')).toBeVisible()
}

/** One anomaly among healthy parts, like the Stitch scenario (synthetic). */
function oneAnomaly() {
  const health = example('b1/ejemplo-degradado.json')
  const components = health.components.map((c: { id: string }) =>
    c.id === 'risk'
      ? c
      : c.id === 'strategies'
        ? c
        : {
            ...c,
            status: 'ok',
            summary: 'Fixture sintético: sin hallazgos.',
            evidence: [],
          },
  )
  return {
    ...health,
    overall: {
      status: 'warning',
      reason: '1 componente(s) con problemas y 1 sin verificar.',
      failing: ['strategies'],
      unverified: ['risk'],
    },
    components,
  }
}

/** Every fixture capture says so on its face. */
async function labelFixture(page: Page) {
  await page.evaluate(() => {
    const tag = document.createElement('div')
    tag.textContent =
      'DATOS DE EJEMPLO · fixture sintético, no son cotizaciones'
    tag.style.cssText =
      'position:fixed;right:16px;bottom:8px;z-index:99999;padding:4px 12px;border:1px solid #f5a524;border-radius:6px;background:#1a1405;color:#f5a524;font:600 12px sans-serif;letter-spacing:.06em'
    document.body.appendChild(tag)
  })
}

async function shot(page: Page, name: string) {
  await labelFixture(page)
  mkdirSync('playwright-artifacts/terminal-observabilidad', { recursive: true })
  await page.screenshot({
    path: join(
      'playwright-artifacts/terminal-observabilidad',
      `${test.info().project.name}-${name}.png`,
    ),
  })
}

/** Positions that go into the Stitch comparison (px, viewport coordinates). */
async function measure(page: Page) {
  const box = async (sel: string) => {
    const b = await page.locator(sel).first().boundingBox()
    return (
      b && {
        x: Math.round(b.x),
        y: Math.round(b.y),
        w: Math.round(b.width),
        h: Math.round(b.height),
      }
    )
  }
  const out = {
    viewport: page.viewportSize(),
    header: await box('header'),
    chart_canvas: await box('canvas'),
    observer: await box('[data-testid="activity-panel"]'),
    ahora: await box('[data-testid="observer-now"]'),
    resultados: await box('[aria-label="Operaciones almacenadas"]'),
    historial: await box('[aria-label="Historial"]'),
  }
  mkdirSync('playwright-artifacts/terminal-observabilidad', { recursive: true })
  writeFileSync(
    join(
      'playwright-artifacts/terminal-observabilidad',
      `${test.info().project.name}-posiciones.json`,
    ),
    JSON.stringify(out, null, 2),
  )
}

/** Desktop layout contract: big chart, AHORA visible without scrolling. */
async function expectChartProtagonist(page: Page) {
  const viewport = page.viewportSize()!
  if (viewport.width <= 900) return
  const chart = await page
    .getByRole('region', { name: /Gráfico/ })
    .boundingBox()
  const side = await page.getByTestId('activity-panel').boundingBox()
  expect(chart!.width).toBeGreaterThan(side!.width * 1.8)
  // Large useful area: the chart is not pushed down by rows of cards.
  const canvas = await page.locator('canvas').first().boundingBox()
  // Stitch starts its chart around 145 px; allow up to 175.
  expect(canvas!.y).toBeLessThanOrEqual(175)
  expect(canvas!.height).toBeGreaterThanOrEqual(viewport.height * 0.5)
  // AHORA is inside the first screen.
  const now = await page.getByTestId('observer-now').boundingBox()
  expect(now!.y + now!.height).toBeLessThanOrEqual(viewport.height)
  expect(now!.y).toBeGreaterThanOrEqual(0)
}

test('waiting state: health in the header, one observer column, chart protagonist', async ({
  page,
}) => {
  const quiet = example('b2/ejemplo-sin-actividad.json')
  await openTerminal(page, example('b1/ejemplo-degradado.json'), quiet)
  await expect(page.getByTestId('health-indicator')).toContainText(
    '5 con problemas',
  )
  await expect(page.getByTestId('window-summary')).toContainText(
    '180 evaluaciones · 0 propuestas direccionales',
  )
  // No source gives the last decision: it is not deduced from the totals.
  await expect(page.getByTestId('last-decision')).toContainText('No disponible')
  await expect(page.getByTestId('activity-panel')).not.toContainText(
    'Esperando',
  )
  await expect(page.getByTestId('stored-total')).toHaveText('0')
  await expectChartProtagonist(page)
  await measure(page)
  await shot(page, 'espera-3h')
})

test('a registered directional signal never shows as an engine proposal in the Terminal', async ({
  page,
}) => {
  // Fixture: B2 example with activity (synthetic data, not a live read).
  await openTerminal(
    page,
    example('b1/ejemplo-degradado.json'),
    example('b2/ejemplo-con-actividad.json'),
  )
  const panel = page.getByTestId('activity-panel')
  // The Terminal shows only Qwen and approved strategies: no engine card.
  await expect(page.getByTestId('stored-total')).toBeVisible()
  await expect(panel).not.toContainText('Propuestas direccionales')
  await expect(page.getByTestId('last-proposal')).toHaveCount(0)
  await expectChartProtagonist(page)
  await shot(page, 'con-senal')
})

test('health inspector is centered, fits the viewport and scrolls inside', async ({
  page,
}) => {
  await openTerminal(
    page,
    oneAnomaly(),
    example('b2/ejemplo-sin-actividad.json'),
  )
  await page.getByTestId('health-indicator').click()
  const dialog = page.getByRole('dialog', { name: 'Salud del sistema' })
  await expect(dialog).toBeVisible()
  const box = await dialog.boundingBox()
  const viewport = page.viewportSize()!
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height)
  if (viewport.width > 900) {
    const center = box!.x + box!.width / 2
    expect(Math.abs(center - viewport.width / 2)).toBeLessThan(8)
  }
  if (viewport.width >= 1440) {
    // The flow diagnosis is collapsed: the six B1 components are identifiable
    // at first sight, with no scrolling inside the inspector.
    const headings = dialog.getByRole('heading', { level: 3 })
    await expect(headings).toHaveCount(6)
    for (let i = 0; i < 6; i += 1) {
      const heading = (await headings.nth(i).boundingBox())!
      expect(heading.y + heading.height).toBeLessThanOrEqual(
        box!.y + box!.height - 48,
      )
    }
  }
  await shot(page, 'inspector-salud')
})

test('terminal with no readable observability source says «Sin datos», never healthy', async ({
  page,
}) => {
  await openTerminal(
    page,
    example('b1/ejemplo-sin-datos.json'),
    example('b2/ejemplo-sin-datos.json'),
  )
  await expect(page.getByTestId('health-indicator')).toContainText(
    '6 sin verificar',
  )
  await expect(page.getByTestId('health-indicator')).not.toContainText(
    'correcta',
  )
  await expect(page.getByTestId('activity-panel')).toContainText(
    'No disponible',
  )
  await shot(page, 'sin-datos')
})
