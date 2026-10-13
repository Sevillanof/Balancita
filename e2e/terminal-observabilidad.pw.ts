import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

/** The documented examples the backend tests generate from its own code. */
const example = (path: string) =>
  JSON.parse(readFileSync(join('docs/mission-control', path), 'utf8'))

const RUN = 'live-market-view'
const NOW = 1_790_000_000_000
const STEP = 300_000

/** Example candles (a deterministic wave): only the chart's layout is under test. */
function candles() {
  let close = 100_000
  return Array.from({ length: 140 }, (_, i) => {
    const open = close
    close = open + Math.sin(i / 3) * 40 + Math.cos(i / 7) * 25
    return {
      time_ms: NOW - (140 - i) * STEP,
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
  const series = candles()
  const bootstrap = {
    schema_version: 1,
    mode: 'paper_live',
    source: 'kraken-public-live-stream.v1',
    active_run_id: RUN,
    products: ['PF_XBTUSD', 'PF_ETHUSD'],
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
        candles: series,
        flow: [],
      },
    }),
  )
  await page.route('**/api-live/api/observability/health', (route) =>
    route.fulfill({ json: health }),
  )
  await page.route('**/api-live/api/observability/activity**', (route) => {
    // The gateway echoes the window and product it was asked for.
    const query = new URL(route.request().url()).searchParams
    route.fulfill({
      json: {
        ...(activity as object),
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
          instrument_id: 'kraken-futures:PF_XBTUSD',
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

async function shot(page: Page, name: string) {
  mkdirSync('playwright-artifacts/terminal-observabilidad', { recursive: true })
  await page.screenshot({
    path: join(
      'playwright-artifacts/terminal-observabilidad',
      `${test.info().project.name}-${name}.png`,
    ),
  })
}

test('terminal shows health in the header and the engine activity beside the chart', async ({
  page,
}) => {
  const quiet = example('b2/ejemplo-sin-actividad.json')
  await openTerminal(page, example('b1/ejemplo-degradado.json'), quiet)
  await expect(page.getByTestId('health-indicator')).toContainText(
    '5 con problemas',
  )
  await expect(page.getByTestId('engine-state')).toContainText(
    'Esperando: sin señales en la ventana',
  )
  await expect(page.getByTestId('stored-total')).toHaveText('0')
  // The chart stays the protagonist: it is wider than the right column (desktop).
  const chart = await page
    .getByRole('region', { name: /Gráfico/ })
    .boundingBox()
  const side = await page.getByTestId('activity-panel').boundingBox()
  if (page.viewportSize()!.width > 900)
    expect(chart!.width).toBeGreaterThan(side!.width * 1.8)
  await shot(page, 'espera-3h')

  await page.getByTestId('health-indicator').click()
  const dialog = page.getByRole('dialog', { name: 'Salud del sistema' })
  await expect(dialog).toBeVisible()
  // It fits the 900 px viewport and scrolls inside, header and footer fixed.
  const box = await dialog.boundingBox()
  const viewport = page.viewportSize()!
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height)
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
