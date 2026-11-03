import { expect, test, type Page } from '@playwright/test'

const NOW = Date.now()
const RUN = 'terminal-viewport-fixture'
const PRODUCT = 'PF_ETHUSD'
const SUMMARY =
  'Síntesis sintética de prueba: Ethereum concentra noticias de seguridad y cambios de infraestructura; las fuentes todavía no permiten confirmar un catalizador común.'

function candles(interval = 60_000) {
  return Array.from({ length: 500 }, (_, index) => {
    const close = 2200 + Math.sin(index / 10) * 20
    return {
      time_ms: NOW - (500 - index) * interval,
      open: String(close - 1),
      high: String(close + 3),
      low: String(close - 3),
      close: String(close),
      volume_btc: '1',
      closed: true,
    }
  })
}

const NEWS = Array.from({ length: 19 }, (_, index) => ({
  id: `synthetic-news-${index}`,
  source: 'Fuente sintética',
  url: `https://example.invalid/eth/${index}`,
  title: `Noticia sintética ${index}: actualización de infraestructura y seguridad de Ethereum para comprobar el espacio disponible`,
  published_at_ms: NOW - (index + 2) * 60_000,
  received_at_ms: NOW - (index + 1) * 60_000,
  relevance: ['high', 'medium', 'low'][index % 3],
  direction: ['bullish', 'bearish', 'neutral'][index % 3],
  analysis_status: 'done',
  analysis_version: 2,
  known_at_ms: NOW - 30_000,
  expires_at_ms: NOW + 600_000,
  eligibility: 'rejected',
  eligibility_reason: 'Fixture: solo lectura, no crea una operación.',
  license_status: 'unknown',
}))

function look(
  ago: number,
  formula: Record<string, unknown>,
  action: string,
  chosen = 'ESPERAR',
) {
  const at = NOW - ago * 15 * 60_000
  return {
    product: PRODUCT,
    bucket_start_ms: at - 15 * 60_000,
    decision_time_ms: at,
    written_at_ms: at,
    action: action === 'LARGO' ? 'LONG' : action === 'CORTO' ? 'SHORT' : 'WAIT',
    chosen,
    confidence: 0.5,
    formula_action: action,
    formula,
  }
}

const independent = (side: number) => ({
  side,
  chosen: 'x',
  support: { x: 0.4 },
})

function exitLooks() {
  return [
    look(
      60,
      {
        maestro: -2,
        puntaje: -1.4,
        portero_si: true,
        portero_p: 0.6,
        noticias_si: false,
        portero_autonomo: independent(-1),
        noticias: { priority: { status: 'none' } },
        motivo: 'maestro y portero autónomo coinciden',
      },
      'CORTO',
      'CORTO',
    ),
    look(
      30,
      {
        maestro: -2,
        puntaje: -1.2,
        noticias_si: false,
        noticias: { priority: { status: 'none' } },
        motivo: 'el maestro no se dio vuelta',
      },
      'MANTENER',
      'MANTENER',
    ),
    look(
      1,
      {
        maestro: -1,
        puntaje: -0.5,
        noticias_si: false,
        noticias: { priority: { status: 'none' } },
        motivo: 'el maestro no se dio vuelta',
      },
      'MANTENER',
      'MANTENER',
    ),
  ]
}

async function openFixture(
  page: Page,
  {
    empty = false,
    summaryStatus = 'ok',
  }: {
    empty?: boolean
    summaryStatus?: 'ok' | 'pending' | 'error' | 'stale'
  } = {},
) {
  const market = {
    schema_version: 'futures-terminal-market.v1',
    as_of_ms: NOW,
    interval_ms: 60_000,
    candles: candles(),
  }
  const bootstrap = {
    schema_version: 1,
    mode: 'paper_live',
    source: 'kraken-public-live-stream.v1',
    active_run_id: RUN,
    products: [PRODUCT],
    market: { status: 'live', last_received_at: NOW, funding: 'unknown' },
    engine: {
      status: 'running',
      reason: 'paper_execution_active',
      commands: 'unavailable',
    },
    terminal_market: market,
  }
  await page.addInitScript(() =>
    localStorage.setItem(
      'balancita.terminal-chart.v1',
      JSON.stringify({
        intervalMs: 60_000,
        overlays: ['ema21'],
        panes: ['flow'],
      }),
    ),
  )
  await page.route('**/api-live/**', (route) =>
    route.fulfill({ status: 503, json: { reason: 'synthetic_unavailable' } }),
  )
  await page.route('**/api-strategies/**', (route) =>
    route.fulfill({ status: 503, json: {} }),
  )
  await page.route('**/api-live/terminal/bootstrap**', (route) =>
    route.fulfill({ json: bootstrap }),
  )
  await page.route('**/api-live/terminal/chart**', (route) => {
    const interval = Number(
      new URL(route.request().url()).searchParams.get('interval_ms') ?? 60_000,
    )
    return route.fulfill({
      json: {
        schema_version: 'futures-terminal-chart.v1',
        interval_ms: interval,
        candles: candles(interval),
        flow: [{ time_ms: NOW - 60_000, buy_volume: 2, sell_volume: 1 }],
      },
    })
  })
  await page.route('**/api-live/qwen/account**', (route) =>
    route.fulfill({
      json: {
        status: 'ok',
        start_usd: 1000,
        balance_usd: 1010,
        realized_usd: 0,
        open_usd: 10,
        open_count: 1,
        funding_incomplete: false,
        steps: [
          {
            product: PRODUCT,
            trade_no: 1,
            side: 'LONG',
            exit_ms: NOW - 400 * 60_000,
            net_usd: 0,
            balance_usd: 1000,
          },
        ],
      },
    }),
  )
  await page.route('**/api-live/qwen/trades**', (route) =>
    route.fulfill({
      json: {
        status: 'ok',
        trades: [
          {
            product: PRODUCT,
            trade_no: 2,
            status: 'open',
            side: 'LONG',
            entry_ms: NOW - 192 * 60_000,
            entry_price: 2215,
            exit_ms: null,
            exit_price: null,
            net_usd: 18.4,
            net_complete_usd: 18.4,
            fees_usd: 1,
            funding_usd: 0.1,
            funding_status: 'complete',
            funding_model: 'kraken-absolute-quantity.v2',
            mark_ms: NOW - 60_000,
            mark_price: 2230,
            closed_by: null,
            hold_min: null,
            notional_usd: 999,
            margin_usd: 999,
            leverage: 1,
          },
          {
            product: PRODUCT,
            trade_no: 3,
            status: 'open',
            side: 'SHORT',
            entry_ms: NOW - 65 * 60_000,
            entry_price: 2230,
            exit_ms: null,
            exit_price: null,
            net_usd: -6.1,
            net_complete_usd: -6.1,
            fees_usd: 1,
            funding_usd: 0.1,
            funding_status: 'complete',
            funding_model: 'kraken-absolute-quantity.v2',
            mark_ms: NOW - 60_000,
            mark_price: 2236,
            closed_by: null,
            hold_min: null,
            notional_usd: 999,
            margin_usd: 999,
            leverage: 1,
          },
          {
            product: PRODUCT,
            trade_no: 4,
            status: 'open',
            side: 'LONG',
            entry_ms: NOW - 20 * 60_000,
            entry_price: 2228,
            exit_ms: null,
            exit_price: null,
            net_usd: 2.3,
            net_complete_usd: 2.3,
            fees_usd: 1,
            funding_usd: 0.1,
            funding_status: 'complete',
            funding_model: 'kraken-absolute-quantity.v2',
            mark_ms: NOW - 60_000,
            mark_price: 2231,
            closed_by: null,
            hold_min: null,
            notional_usd: 999,
            margin_usd: 999,
            leverage: 1,
          },
        ],
      },
    }),
  )
  await page.route('**/api-live/qwen/decisions**', (route) =>
    route.fulfill({
      json: {
        status: 'ok',
        decisions: exitLooks(),
        skipped: [],
        heartbeat: { heartbeat_ms: NOW, model_ok: true, data_health: {} },
      },
    }),
  )
  await page.route('**/api-live/news**', (route) =>
    route.fulfill({
      json: {
        status: 'ok',
        items: empty ? [] : NEWS,
        checked_at_ms: NOW,
        policy: 'priority_v2',
        collection: {
          status: 'warning',
          reason: 'Fixture: una fuente está atrasada.',
        },
        briefing: {
          status: summaryStatus,
          product: PRODUCT,
          text:
            summaryStatus === 'pending' || summaryStatus === 'error'
              ? null
              : SUMMARY,
          known_at_ms: summaryStatus === 'pending' ? null : NOW - 30_000,
          checked_at_ms: NOW,
          expires_at_ms: summaryStatus === 'stale' ? NOW - 1 : NOW + 900_000,
          source_count: 1,
          sources: [
            {
              id: NEWS[0]!.id,
              source: NEWS[0]!.source,
              url: NEWS[0]!.url,
              published_at_ms: NEWS[0]!.published_at_ms,
              received_at_ms: NEWS[0]!.received_at_ms,
              license_status: 'unknown',
            },
          ],
          reason: summaryStatus === 'error' ? 'synthetic_model_error' : null,
        },
      },
    }),
  )
  await page.routeWebSocket(/\/api-live\/terminal\/stream/, (socket) => {
    socket.onMessage(() =>
      socket.send(
        JSON.stringify({
          schema_version: 1,
          event_id: 'synthetic-event',
          stream_id: RUN,
          run_id: RUN,
          seq: 0,
          type: 'snapshot',
          instrument_id: `kraken-futures:${PRODUCT}`,
          event_time: NOW,
          published_at: NOW,
          data: {
            watermark: 0,
            market,
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
  await expect(
    page.getByTestId(
      (page.viewportSize()?.width ?? 0) <= 600
        ? 'mobile-terminal'
        : 'terminal-operation-card',
    ),
  ).toBeVisible()
}

// La Terminal es una pantalla viva: nada de lo que haga la persona (ni la red,
// ni el navegador, ni el servidor de Vite) puede recargar la página entera.
async function arm(page: Page) {
  await openFixture(page)
  await page.waitForTimeout(1200)
  await page.evaluate(() => {
    ;(window as unknown as { __vivo: number }).__vivo = 1
  })
}
async function sigueViva(page: Page) {
  await page.waitForTimeout(1500)
  expect(
    await page.evaluate(
      () => (window as unknown as { __vivo?: number }).__vivo,
    ),
  ).toBe(1)
}

test('cortar el socket de Vite no recarga la página', async ({ page }) => {
  await page.routeWebSocket(/token=/, (ws) => {
    const server = ws.connectToServer()
    void server
    setTimeout(() => ws.close(), 800)
  })
  await arm(page)
  await page.waitForTimeout(4000)
  await sigueViva(page)
})

test('red cortada y vuelta, pestaña en segundo plano', async ({
  page,
  context,
}) => {
  await arm(page)
  await context.setOffline(true)
  await page.waitForTimeout(1500)
  await context.setOffline(false)
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    })
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('blur'))
  })
  await page.waitForTimeout(1000)
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    })
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('focus'))
  })
  await sigueViva(page)
})

test('cruzar 600 px y rotar no recarga', async ({ page }) => {
  await arm(page)
  for (const [width, height] of [
    [900, 700],
    [390, 844],
    [844, 390],
    [1280, 800],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height })
    await page.waitForTimeout(500)
  }
  await sigueViva(page)
})

test('interacciones mobile no recargan', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile-390x844')
  await arm(page)
  await page.getByTestId('mobile-op-net').first().click()
  for (const name of ['Noticias', 'Decisiones', 'Estado', 'Operaciones']) {
    await page.getByRole('tab', { name }).click()
    await page.waitForTimeout(250)
  }
  const box = (await page.getByTestId('mobile-chart').boundingBox())!
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5)
  await page.mouse.up()
  await sigueViva(page)
  await expect(page.getByTestId('mobile-terminal')).toBeVisible()
})

test('interacciones desktop no recargan', async ({ page }, info) => {
  test.skip(info.project.name === 'mobile-390x844')
  await arm(page)
  await page.mouse.click(600, 400)
  await page.mouse.wheel(0, -300)
  await page.keyboard.press('ArrowLeft')
  for (const b of await page.getByRole('button').all()) {
    if (await b.isVisible()) await b.click({ timeout: 800 }).catch(() => {})
  }
  await sigueViva(page)
})
