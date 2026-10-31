import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

const RUN = 'live-market-view'

const market = {
  schema_version: 'futures-terminal-market.v1',
  as_of_ms: 21_600_000,
  interval_ms: 60_000,
  candles: [
    {
      time_ms: 21_540_000,
      open: '100000',
      high: '100050',
      low: '99950',
      close: '100000',
      volume_btc: '1',
      closed: true,
    },
  ],
}

const bootstrap = {
  schema_version: 1,
  mode: 'paper_live',
  source: 'kraken-public-live-stream.v1',
  active_run_id: RUN,
  engine: {
    status: 'running',
    reason: 'paper_execution_active',
    commands: 'unavailable',
  },
  terminal_market: market,
}

function analyses(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    analysis_id: `analysis-${index + 1}`,
    action: index % 7 === 3 ? 'LONG' : 'WAIT',
    reason_codes: ['no_directional_proposal'],
    decision_time_ms: 21_600_000 + index * 60_000,
    runtime_version: 'futures-runtime.v1',
  }))
}

/** Serves the live terminal with `count` stored decisions, no backend needed. */
async function openTerminal(page: Page, count: number) {
  const first = !routed.has(page)
  routed.add(page)
  counts.set(page, count)
  if (first) await routeTerminal(page)
  await page.goto('/terminal')
  // The decisions live in the «Historial de señales» window of the side column.
  await expect(
    page.getByRole('button', { name: /Historial de señales/ }),
  ).toBeVisible()
}

const routed = new WeakSet<Page>()
const counts = new WeakMap<Page, number>()

async function routeTerminal(page: Page) {
  await page.route('**/api-live/terminal/bootstrap**', (route) =>
    route.fulfill({ json: bootstrap }),
  )
  await page.routeWebSocket(/\/api-live\/terminal\/stream/, (socket) => {
    socket.onMessage(() => {
      socket.send(
        JSON.stringify({
          schema_version: 1,
          event_id: 'event-1',
          stream_id: 'stream-1',
          run_id: RUN,
          seq: 0,
          type: 'snapshot',
          instrument_id: 'kraken-futures:PF_XBTUSD',
          event_time: 21_600_000,
          published_at: 21_600_000,
          data: {
            watermark: 0,
            market,
            state: {
              run_id: RUN,
              state_version: 1,
              analyses: analyses(counts.get(page) ?? 0),
              orders: [],
              fills: [],
            },
          },
        }),
      )
    })
  })
}

async function shot(page: Page, name: string) {
  mkdirSync('playwright-artifacts/screens', { recursive: true })
  await page.screenshot({
    path: join(
      'playwright-artifacts/screens',
      `${test.info().project.name}-${name}.png`,
    ),
    fullPage: true,
  })
}

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
}

test('terminal decisions list keeps its height whatever the number of verdicts', async ({
  page,
}) => {
  await openTerminal(page, 5)
  const frame = page.getByTestId('activity-panel')
  const small = await frame.boundingBox()
  const smallPage = await page.evaluate(() => document.body.scrollHeight)
  await shot(page, 'terminal-5')

  await openTerminal(page, 400)
  const large = await frame.boundingBox()
  const largePage = await page.evaluate(() => document.body.scrollHeight)
  await shot(page, 'terminal-400')

  // The list itself is visible and scrolls inside the panel; the frame that
  // holds it keeps the same height.
  await page.getByRole('button', { name: /Historial de señales/ }).click()
  const panel = page.getByRole('region', { name: 'Decisiones del motor' })
  await expect(panel).toBeVisible()
  const list = panel.locator('[aria-label="Lista de decisiones"]')
  expect((await list.boundingBox())!.height).toBeGreaterThan(100)
  expect(large!.height).toBe(small!.height)
  expect(largePage).toBe(smallPage)
  await noHorizontalScroll(page)
})

test('estrategias without the registry shows the error and no example data', async ({
  page,
}) => {
  await page.route('**/api-strategies/**', (route) =>
    route.fulfill({ status: 503, json: {} }),
  )
  await page.route('**/api-live/**', (route) =>
    route.fulfill({ status: 503, json: {} }),
  )
  await page.goto('/estrategias')
  // The same status chips as the terminal, even when the gateway is down.
  await expect(page.getByTestId('flow-status')).toHaveText('Flujo sin conexión')
  await page.getByTestId('flow-status').click()
  await page.getByText('Diagnóstico del flujo, uso y modo').click()
  await expect(page.getByTestId('system-usage')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('alert').first()).toContainText(
    'No se muestran datos de ejemplo',
  )
  await shot(page, 'estrategias')
  await noHorizontalScroll(page)
})

/** A fresh, valid `system-usage.v1` response in the current resource format. */
function systemUsage(cpu: number, rssMb: number, totalMb: number) {
  const now = Date.now()
  return {
    schema: 'system-usage.v1',
    status: 'ok',
    at_ms: now,
    cached_at_ms: now,
    sampled_at_ms: now - 1_000,
    supervisor_updated_at_ms: now - 1_000,
    cpu_pct: cpu,
    rss_mb: rssMb,
    qwen: { running: true },
    kronos: { running: true },
    storage: {
      status: 'ok',
      scope: 'configured_data_directory',
      complete: true,
      sampled_at_ms: now - 1_000,
      total_bytes: Math.round(totalMb * 1_048_576),
      bytes: { sqlite_main: 0, wal: 0, shm: 0, log: 0, other: 0 },
      max_entries: 1000,
      max_depth: 3,
    },
  }
}

test('terminal live header shows the flow status and the usage chip', async ({
  page,
}) => {
  await page.route('**/api-live/terminal/bootstrap**', (route) =>
    route.fulfill({
      json: {
        ...bootstrap,
        mode: 'paper_live',
        source: 'kraken-public-live-stream.v1',
        engine: { status: 'off' },
      },
    }),
  )
  await page.route('**/api-live/health', (route) =>
    route.fulfill({
      json: {
        processes: {
          capture: { status: 'running' },
          q: { status: 'restarting' },
        },
      },
    }),
  )
  await page.route('**/api-live/system', (route) =>
    route.fulfill({
      json: systemUsage(37.4, 1320, 148),
    }),
  )
  await page.routeWebSocket(/\/api-live\/terminal\/stream/, () => {})
  await page.goto('/terminal')
  await expect(page.getByTestId('flow-status')).toHaveText('Flujo sin conexión')
  await page.getByTestId('flow-status').click()
  await page.getByText('Diagnóstico del flujo, uso y modo').click()
  await expect(page.getByTestId('system-usage')).toContainText('CPU 37 %')
  await expect(page.getByTestId('system-usage')).toContainText(
    /DATOS 148[.,]0 MiB/,
  )
  await expect(page.getByTestId('system-usage')).toContainText('QWEN activo')
  await expect(page.getByTestId('system-usage')).toContainText('KRONOS activo')
  await expect(page.getByText('FLUJO DESCONECTADO')).toBeVisible()
  await shot(page, 'terminal-flow')
  await noHorizontalScroll(page)
})

test('estrategias shows the same chips as the terminal when the gateway is up', async ({
  page,
}) => {
  await page.route('**/api-strategies/**', (route) =>
    route.fulfill({ status: 503, json: {} }),
  )
  await page.route('**/api-live/health', (route) =>
    route.fulfill({
      json: {
        processes: { capture: { status: 'running' } },
        capture: { lastReceivedAt: Date.now() - 2_000 },
      },
    }),
  )
  await page.route('**/api-live/system', (route) =>
    route.fulfill({
      json: systemUsage(15, 900, 3419),
    }),
  )
  await page.goto('/estrategias')
  await expect(page.getByTestId('flow-status')).toHaveText('Flujo en vivo')
  await page.getByTestId('flow-status').click()
  await page.getByText('Diagnóstico del flujo, uso y modo').click()
  await expect(page.getByTestId('system-usage')).toContainText(
    /CPU 15 % · DATOS 3419[.,]0 MiB · QWEN activo · KRONOS activo/,
  )
  await expect(page.getByText('PAPER · KRAKEN')).toBeVisible()
  await shot(page, 'estrategias-chips')
  await noHorizontalScroll(page)
})

/*
 * Chart height with sub-panes. SYNTHETIC FIXTURE, not market data: it only
 * gives the chart some candles and flow points so its geometry can be
 * measured in live mode (flow and open-interest panes need live data).
 */
test('terminal chart with two sub-panes takes the available height', async ({
  page,
}) => {
  const interval = 60_000
  const end = 1_800_000_000_000
  const candles = Array.from({ length: 120 }, (_, index) => {
    const open = 100_000 + Math.sin(index / 6) * 200
    return {
      time_ms: end - (120 - index) * interval,
      open: String(open),
      high: String(open + 60),
      low: String(open - 60),
      close: String(open + Math.cos(index / 5) * 40),
      volume_btc: '1.5',
      closed: true,
    }
  })
  const liveMarket = {
    schema_version: 'futures-terminal-market.v1',
    as_of_ms: end,
    interval_ms: interval,
    candles,
  }
  const liveBootstrap = {
    schema_version: 1,
    mode: 'paper_live',
    source: 'kraken-public-live-stream.v1',
    active_run_id: 'live-market-view',
    market: { status: 'live', last_received_at: end, funding: 'unknown' },
    engine: { status: 'off', reason: 'fixture', commands: 'unavailable' },
    terminal_market: liveMarket,
  }
  await page.route('**/api-live/terminal/bootstrap**', (route) =>
    route.fulfill({ json: liveBootstrap }),
  )
  await page.route('**/api-live/terminal/chart**', (route) =>
    route.fulfill({
      json: {
        schema_version: 'futures-terminal-chart.v1',
        interval_ms: interval,
        candles,
        flow: candles.map((candle, index) => ({
          time_ms: candle.time_ms,
          buy_volume: 1 + (index % 5),
          sell_volume: 1 + (index % 3),
          open_interest: 1_000 + index,
        })),
      },
    }),
  )
  await page.routeWebSocket(/\/api-live\/terminal\/stream/, (socket) => {
    socket.onMessage(() => {
      socket.send(
        JSON.stringify({
          schema_version: 1,
          event_id: 'event-1',
          stream_id: 'stream-1',
          run_id: 'live-market-view',
          seq: 0,
          type: 'snapshot',
          instrument_id: 'kraken-futures:PF_XBTUSD',
          event_time: end,
          published_at: end,
          data: {
            watermark: 0,
            market: liveMarket,
            state: { run_id: 'live-market-view', state_version: 0 },
          },
        }),
      )
    })
  })
  await page.goto('/terminal')
  const chart = page.getByTestId('approved-chart-renderer')
  await expect(chart).toBeVisible()
  // The indicator and pane controls are folded behind one line.
  await page.getByRole('button', { name: 'Indicadores y paneles' }).click()
  await expect(
    page.getByRole('checkbox', { name: 'Compra/venta' }),
  ).toBeChecked()
  // Open interest is not a default pane any more: the test turns it on.
  await page.getByRole('checkbox', { name: 'Interés abierto' }).check()
  await page.getByRole('button', { name: 'Cerrar', exact: true }).click()
  const { width, height } = page.viewportSize()!
  // The chart (price area plus the two sub-panes) fills its frame, which has
  // the height of the decisions column next to it.
  const box = await chart.boundingBox()
  expect(box!.height).toBeGreaterThanOrEqual(300)
  const frame = await page
    .locator('section[aria-label^="Gráfico"]')
    .first()
    .boundingBox()
  const side = await page.getByTestId('activity-panel').boundingBox()
  if (Math.abs(frame!.y - side!.y) < 2)
    expect(Math.abs(frame!.height - side!.height)).toBeLessThanOrEqual(1)
  // Compact metrics: on a phone the chart starts well inside the first screen.
  if (width <= 600) expect(box!.y).toBeLessThan(height * 0.55)
  await noHorizontalScroll(page)
  await shot(page, 'terminal-live-subpanes-fixture')
})
