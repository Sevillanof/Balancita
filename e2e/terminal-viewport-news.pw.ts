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
            side: 'SHORT',
            entry_ms: NOW - 300 * 60_000,
            entry_price: 2210,
            exit_ms: null,
            exit_price: null,
            net_usd: 10,
            net_complete_usd: 10,
            fees_usd: 1,
            funding_usd: 0.1,
            funding_status: 'complete',
            funding_model: 'kraken-absolute-quantity.v2',
            mark_ms: NOW - 60_000,
            mark_price: 2185,
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
  await expect(page.getByTestId('terminal-operation-card')).toBeVisible()
  await expect(page.getByTestId('qwen-news-briefing')).toBeVisible()
  // On a very short window the panel asks for more height instead of
  // squeezing a headline into no space (see `shortWindow` below).
  if (!empty)
    await expect(
      page
        .getByRole('list', { name: 'Lista de noticias' })
        .locator(':scope > li')
        .first()
        .or(page.getByText('Ampliá la altura de la ventana')),
    ).toBeVisible()
}

async function assertViewport(page: Page) {
  const result = await page.evaluate(() => {
    const root = document.documentElement
    const surface = document.querySelector(
      '[data-testid="terminal-chart-surface"]',
    )!
    const card = document.querySelector(
      '[data-testid="terminal-operation-card"]',
    )!
    const fields = [
      card.querySelector('strong')!,
      card.querySelector('[data-testid="operation-net"]')!,
      card.querySelector('[data-testid="operation-entry"]')!,
      card.querySelector('button')!,
    ].map((element) => element.getBoundingClientRect())
    return {
      overflowX: root.scrollWidth - innerWidth,
      overflowY: root.scrollHeight - innerHeight,
      chartHeight: surface.getBoundingClientRect().height,
      chartPaneHeight:
        surface.querySelector('canvas')?.getBoundingClientRect().height ?? 0,
      cardCollisions:
        fields[0]!.bottom > fields[1]!.top ||
        fields[1]!.bottom > fields[3]!.top,
      clipped: Array.from(
        document.querySelectorAll(
          '[data-testid="terminal-operation-card"], [data-testid="terminal-news-panel"], [data-testid="activity-panel"]',
        ),
      )
        .filter((element) => element.scrollHeight > element.clientHeight + 1)
        // On a 390 px high window the news panel cannot hold even the pinned
        // Qwen card and the pager; it says so instead of showing a headline.
        .filter(
          (element) =>
            innerHeight >= 480 ||
            element.getAttribute('data-testid') !== 'terminal-news-panel',
        )
        .map((element) => element.getAttribute('data-testid')),
    }
  })
  expect(result.overflowX).toBe(0)
  expect(result.overflowY).toBe(0)
  expect(result.chartHeight).toBeGreaterThan(90)
  expect(result.chartPaneHeight).toBeGreaterThan(45)
  expect(result.cardCollisions).toBe(false)
  expect(result.clipped).toEqual([])
}

for (const [width, height] of [
  [1440, 900],
  [1366, 768],
  [1024, 650],
  [900, 600],
  [800, 600],
  [700, 600],
  [844, 390],
  [390, 844],
  [390, 640],
  [360, 640],
]) {
  test(`Terminal C fits actual synthetic components at ${width}x${height}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: width!, height: height! })
    await openFixture(page)
    await assertViewport(page)
    // A 390 px high window has no room for a headline: the panel says so.
    if (height! < 480) {
      await expect(
        page.getByText('Ampliá la altura de la ventana'),
      ).toBeVisible()
      return
    }
    const packing = await page.evaluate(() => {
      const space = document
        .querySelector('[data-testid="news-available-space"]')!
        .getBoundingClientRect().height
      const measured = [
        ...document.querySelectorAll('[aria-hidden="true"] [data-news-id]'),
      ].map((element) => element.getBoundingClientRect().height)
      const rows = [
        ...document.querySelectorAll('[aria-label="Lista de noticias"] > li'),
      ]
      const count = rows.length
      const used =
        measured.slice(0, count).reduce((sum, height) => sum + height, 0) +
        (count - 1) * 8
      return {
        count,
        maximal:
          count === measured.length || used + 8 + measured[count]! > space,
        gap:
          space -
          (rows.at(-1)!.getBoundingClientRect().bottom -
            rows[0]!.getBoundingClientRect().top),
      }
    })
    expect(packing.count).toBeGreaterThan(0)
    expect(packing.maximal).toBe(true)
    expect(Math.abs(packing.gap)).toBeLessThanOrEqual(2)
  })
}

test('Qwen stays pinned during pagination, search and read-only detail dialogs', async ({
  page,
}) => {
  const writes: string[] = []
  page.on('request', (request) => {
    if (request.method() !== 'GET') writes.push(request.url())
  })
  await openFixture(page)
  const briefing = page.getByTestId('qwen-news-briefing')
  await page.getByRole('button', { name: 'Siguiente', exact: true }).click()
  await expect(briefing).toContainText(SUMMARY)
  await page
    .getByRole('button', { name: 'Buscar noticias', exact: true })
    .click()
  await page.getByRole('searchbox').fill('sin coincidencias')
  await page.getByRole('button', { name: 'Cerrar', exact: true }).click()
  await expect(
    page.getByText('Sin noticias para esa fecha u hora.'),
  ).toBeVisible()
  await expect(briefing).toContainText(SUMMARY)
  await page
    .getByRole('button', { name: 'Ver resumen y fuentes de Qwen' })
    .click()
  await expect(page.getByRole('dialog')).toContainText('unknown')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: /Historial de señales/ }).click()
  await expect(
    page.getByRole('dialog', { name: 'Historial de señales' }),
  ).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: /Datos y costes/ }).click()
  await expect(page.getByRole('dialog')).toContainText('Apalancamiento')
  await page.keyboard.press('Escape')
  await page.getByTestId('account-balance').click()
  await expect(
    page.getByRole('dialog', { name: 'Saldo de la cuenta simulada' }),
  ).toBeVisible()
  await assertViewport(page)
  await page.keyboard.press('Escape')
  expect(writes).toEqual([])
  await assertViewport(page)
})

for (const summaryStatus of ['pending', 'error', 'stale'] as const) {
  test(`empty news keeps an honest pinned ${summaryStatus} card without scroll`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 640 })
    await openFixture(page, { empty: true, summaryStatus })
    await expect(page.getByTestId('qwen-news-briefing')).toContainText(
      summaryStatus === 'pending'
        ? 'Pendiente'
        : summaryStatus === 'error'
          ? 'No disponible'
          : 'Desactualizado',
    )
    await assertViewport(page)
  })
}

test('short landscape account inspection stays inside the viewport', async ({
  page,
}) => {
  await page.setViewportSize({ width: 844, height: 390 })
  await openFixture(page)
  await page.getByTestId('account-balance').click()
  const bounds = await page
    .getByRole('dialog', { name: 'Saldo de la cuenta simulada' })
    .boundingBox()
  expect(bounds!.y).toBeGreaterThanOrEqual(0)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(390)
  await assertViewport(page)
})
