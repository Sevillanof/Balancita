import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

const RUN = 'local-protection-v1'

const market = {
  schema_version: 'mock-terminal-market.v1',
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
  mode: 'mock',
  source: 'local-protection.v1',
  active_run_id: RUN,
  engine: { scenario_status: 'Escenario iniciado' },
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

/** Serves the MOCK terminal with `count` stored decisions, no backend needed. */
async function openTerminal(page: Page, count: number) {
  const first = !routed.has(page)
  routed.add(page)
  counts.set(page, count)
  if (first) await routeTerminal(page)
  await page.goto('/terminal')
  await expect(
    page.getByRole('region', { name: 'Decisiones del motor' }),
  ).toBeVisible()
}

const routed = new WeakSet<Page>()
const counts = new WeakMap<Page, number>()

async function routeTerminal(page: Page) {
  await page.route('**/api-live/terminal/bootstrap', (route) =>
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
  const panel = page.getByRole('region', { name: 'Decisiones del motor' })
  const small = await panel.boundingBox()
  const smallPage = await page.evaluate(() => document.body.scrollHeight)
  await shot(page, 'terminal-5')

  await openTerminal(page, 400)
  const large = await panel.boundingBox()
  const largePage = await page.evaluate(() => document.body.scrollHeight)
  await shot(page, 'terminal-400')

  // The list itself is visible and scrolls inside the panel.
  const list = panel.locator('.connected-terminal__decision-list')
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
  await expect(page.getByRole('alert').first()).toContainText(
    'No se muestran datos de ejemplo',
  )
  await shot(page, 'estrategias')
  await noHorizontalScroll(page)
})

test('terminal live header shows the flow status and the usage chip', async ({
  page,
}) => {
  await page.route('**/api-live/terminal/bootstrap', (route) =>
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
      json: {
        cpu_pct: 37.4,
        rss_mb: 1320,
        cores: 8,
        data_mb: 148.2,
        qwen: {
          running: true,
          decisions: { total: 900, last_hour: 12, avg_latency_ms: 1100 },
          exit_decisions: 40,
        },
        kronos: { running: true, trades: 7, decisions: 30 },
      },
    }),
  )
  await page.routeWebSocket(/\/api-live\/terminal\/stream/, () => {})
  await page.goto('/terminal')
  await expect(page.getByTestId('system-usage')).toContainText('CPU 37 %')
  await expect(page.getByTestId('system-usage')).toContainText('DATOS 148 MB')
  await expect(page.getByTestId('system-usage')).toContainText('QWEN 12/h')
  await expect(page.getByTestId('system-usage')).toContainText('KRONOS 7 op.')
  await expect(page.getByTestId('flow-status')).toHaveText('FLUJO DESCONECTADO')
  await shot(page, 'terminal-flow')
  await noHorizontalScroll(page)
})
