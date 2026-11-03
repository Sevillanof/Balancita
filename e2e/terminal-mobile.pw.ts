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

const OUT = process.env.SHOTS_DIR ?? 'test-results/mobile'
test('vista mobile', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile-390x844')
  await openFixture(page)
  await page.waitForTimeout(1500)
  await page.screenshot({ path: `${OUT}/1-operaciones.png` })
  await page.getByTestId('mobile-op-net').first().click()
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${OUT}/1b-operacion-abierta.png` })
  for (const [name, file] of [
    ['Noticias', '2-noticias'],
    ['Decisiones', '3-decisiones'],
    ['Estado', '4-estado'],
  ] as const) {
    await page.getByRole('tab', { name }).click()
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${OUT}/${file}.png` })
  }
  await page.getByRole('tab', { name: 'Operaciones' }).click()
  const box = (await page.getByTestId('mobile-chart').boundingBox())!
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5)
  await page.mouse.down()
  await page.waitForTimeout(700)
  await page.screenshot({ path: `${OUT}/5-toque-grafico.png` })
  await page.mouse.up()
})

test('desktop sigue igual (captura de control)', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-1440x900')
  await openFixture(page)
  await page.waitForTimeout(1500)
  await expect(page.getByTestId('mobile-terminal')).toHaveCount(0)
  await page.screenshot({ path: `${OUT}/6-control-desktop.png` })
})
