import { expect, test, type Page } from '@playwright/test'

const NOW = Date.now()
const RUN = 'terminal-lifecycle-fixture'
const PRODUCT = 'PF_ETHUSD'
const SHOTS = process.env.LIFECYCLE_SHOTS

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

/** One look of the formulas, `ago` quarters of an hour back. */
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

function entryLooks() {
  return [
    look(
      7,
      {
        maestro: 2,
        puntaje: 1.1,
        portero_si: true,
        portero_p: 0.62,
        noticias_si: false,
        portero_autonomo: independent(1),
        noticias: { priority: { status: 'none' } },
        motivo: 'maestro y portero autónomo coinciden',
      },
      'LARGO',
      'LARGO',
    ),
    look(
      6,
      {
        maestro: 1,
        puntaje: 0.4,
        portero_si: false,
        portero_p: 0.4,
        noticias_si: false,
        portero_autonomo: independent(0),
        noticias: { priority: { status: 'none' } },
        motivo: 'el maestro no está fuerte',
      },
      'ESPERAR',
    ),
    look(
      5,
      {
        maestro: -1,
        puntaje: -0.5,
        portero_si: false,
        portero_p: 0.35,
        noticias_si: false,
        portero_autonomo: independent(-1),
        noticias: { priority: { status: 'none' } },
        motivo: 'el maestro no está fuerte',
      },
      'ESPERAR',
    ),
    look(
      3,
      {
        maestro: -2,
        puntaje: -1.4,
        portero_si: false,
        portero_p: 0.38,
        noticias_si: false,
        portero_autonomo: independent(1),
        noticias: { priority: { status: 'none' } },
        motivo: 'maestro y portero autónomo no coinciden',
      },
      'ESPERAR',
    ),
    look(
      1,
      {
        maestro: -2,
        puntaje: -1.5,
        portero_si: false,
        portero_p: 0.38,
        noticias_si: false,
        portero_autonomo: independent(1),
        noticias: { priority: { status: 'none' } },
        motivo: 'maestro y portero autónomo no coinciden',
      },
      'ESPERAR',
    ),
  ]
}

const verdict = (acerto: boolean | null, texto: string) => ({
  acerto,
  costo_error_pb: 0,
  regla: 'fixture',
  texto,
})

/**
 * The auditor's verdicts as the gateway serves them (`auditoria`), one per
 * entry look, oldest first: resolved at 36 h, only at 12 h, a fixed rule, and
 * two still unresolved (the 30 minute judge takes over, then pending).
 */
function withAuditor<T extends object>(looks: T[]) {
  const audit = [
    {
      accion: 'ENTRAR',
      veredicto_12h: verdict(true, 'si entraba: +9 pb'),
      veredicto_24h: verdict(true, 'si entraba: +15 pb'),
      veredicto_36h: verdict(true, 'si entraba: +23 pb'),
      despues: null,
    },
    {
      accion: 'NO_ENTRAR_maestro',
      veredicto_12h: verdict(false, 'quedaba: −41 pb'),
      veredicto_24h: null,
      veredicto_36h: null,
      despues: null,
    },
    {
      accion: 'NO_ENTRAR_regla',
      veredicto_12h: null,
      veredicto_24h: verdict(null, 'regla fija'),
      veredicto_36h: null,
      despues: null,
    },
  ]
  return looks.map((value, index) => ({
    ...value,
    auditoria: audit[index] ?? null,
  }))
}

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

const HASH = 'a'.repeat(64)
const phase = (at: number) => ({
  receipt_id: HASH,
  cost_model_hash: 'b'.repeat(64),
  fee_kind: 'taker',
  price: '2210',
  quantity: '0.45',
  fee_rate: '0.0005',
  fee_usd: '0.5',
  source:
    'https://futures.kraken.com/derivatives/api/v3/orderbook?symbol=PF_ETHUSD',
  signal_at_ms: at,
  decision_at_ms: at,
  requested_at_ms: at,
  received_at_ms: at,
  server_at_ms: at,
  executed_at_ms: at,
})

function openTrade(entryAgoMin: number, withPlan: boolean) {
  const entry = NOW - entryAgoMin * 60_000
  return {
    product: PRODUCT,
    trade_no: 2,
    status: 'open',
    side: 'SHORT',
    entry_ms: entry,
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
    execution: {
      model: 'kraken-futures-book.v1',
      entry: phase(entry),
      exit: null,
      mark: null,
      exit_plan: withPlan
        ? {
            mode: 'sigue',
            started_ms: NOW - 19 * 60_000,
            ttl_ms: 45 * 60_000,
            tope_bp: '40',
            price: '2190',
            reprices: 2,
            outcome: null,
            ended_ms: null,
          }
        : null,
    },
  }
}

async function openFixture(
  page: Page,
  { decisions, trades }: { decisions: unknown[]; trades: unknown[] },
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
      JSON.stringify({ intervalMs: 300_000, overlays: [], panes: [] }),
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
        flow: [],
      },
    })
  })
  await page.route('**/api-live/qwen/decisions**', (route) =>
    route.fulfill({
      json: {
        status: 'ok',
        decisions,
        skipped: [],
        heartbeat: { heartbeat_ms: NOW, model_ok: true, data_health: {} },
      },
    }),
  )
  await page.route('**/api-live/qwen/trades**', (route) =>
    route.fulfill({ json: { status: 'ok', trades } }),
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
  await expect(page.getByTestId('approved-chart-renderer')).toBeVisible()
}

test('without an open operation the strip shows the entry steps', async ({
  page,
}) => {
  await openFixture(page, { decisions: withAuditor(entryLooks()), trades: [] })
  const strip = page.getByRole('group', {
    name: 'Pasos para entrar a una operación',
  })
  await expect(strip).toBeVisible()
  await expect(strip.getByRole('button')).toHaveCount(5)
  await strip.getByRole('button', { name: /^Portero/ }).click()
  const detail = page.getByRole('dialog', {
    name: /Portero: última evaluación/,
  })
  await expect(detail).toContainText('Frena la entrada')
  await expect(detail).toContainText('Últimas 5 miradas')
  if (SHOTS)
    await page.screenshot({
      path: `${SHOTS}/entrada-${test.info().project.name}.png`,
    })
  await page.keyboard.press('Escape')
  await expect(detail).toBeHidden()
  // Every past look is judged against the price 30 minutes later; a click on a dot keeps the detail open.
  await strip.getByRole('button', { name: /^Maestro/ }).click()
  const master = page.getByRole('dialog', {
    name: /Maestro: última evaluación/,
  })
  const dots = master.getByRole('button', { name: /^Ir a la mirada/ })
  await expect(dots).toHaveCount(5)
  await expect(dots.last()).toHaveAttribute(
    'title',
    /todavía no pasaron 30 min/,
  )
  await expect(dots.first()).toHaveAttribute('title', /acertó|falló/)
  // The auditor decides once it has a verdict: the longest horizon wins, the dots keep their size and place.
  await expect(dots.nth(0)).toHaveAttribute(
    'title',
    /Auditor a 36 h \(definitivo\): si entraba: \+23 pb · acertó/,
  )
  await expect(dots.nth(1)).toHaveAttribute(
    'title',
    /Auditor a 12 h \(provisorio\): quedaba: −41 pb · falló/,
  )
  await expect(dots.nth(2)).toHaveAttribute(
    'title',
    /Auditor a 24 h \(provisorio\): regla fija · regla fija, no se juzga/,
  )
  // Not resolved yet: the price 30 minutes later, and it says it is waiting for the auditor.
  await expect(dots.nth(3)).toHaveAttribute(
    'title',
    /A 30 min: [+−]\d+ pb · (acertó|falló) \(hasta que el auditor resuelva a las 12 h\)/,
  )
  await expect(master).toContainText(
    'A los 30 min mide el precio; a las 12, 24 y 36 h el auditor pone el veredicto real',
  )
  await expect(master.getByRole('button')).toHaveCount(5)
  await expect(dots.nth(0).locator('i')).toHaveClass(/bg-long/)
  await expect(dots.nth(1).locator('i')).toHaveClass(/bg-short/)
  await expect(dots.nth(2).locator('i')).toHaveClass(/bg-line\b/)
  if (SHOTS)
    await master.screenshot({
      path: `${SHOTS}/decision-optima-auditor-${test.info().project.name}.png`,
    })
  if (SHOTS)
    await page.screenshot({
      path: `${SHOTS}/decision-optima-${test.info().project.name}.png`,
    })
  await dots.first().click()
  await expect(master).toBeVisible()
  if (SHOTS)
    await page.screenshot({
      path: `${SHOTS}/decision-optima-salto-${test.info().project.name}.png`,
    })
  // A grey step is not a failure: it says what it is waiting for.
  await strip.getByRole('button', { name: /^Noticias/ }).click()
  const news = page.getByRole('dialog', { name: /Noticias: última evaluación/ })
  await expect(news).toContainText('sin señal')
  await expect(news).toContainText('Sin catalizador habilitado')
  if (SHOTS)
    await page.screenshot({
      path: `${SHOTS}/noticias-${test.info().project.name}.png`,
    })
  await strip.getByRole('button', { name: /^Entrada/ }).click()
  await expect(
    page.getByRole('dialog', { name: /Entrada: última evaluación/ }),
  ).toContainText('en espera')
})

test('with an open operation the strip shows the exit steps', async ({
  page,
}) => {
  await openFixture(page, {
    decisions: exitLooks(),
    trades: [openTrade(5 * 60, true)],
  })
  const strip = page.getByRole('group', {
    name: 'Pasos para salir de la operación',
  })
  await expect(strip).toBeVisible()
  await expect(strip.getByRole('button')).toHaveCount(6)
  await strip.getByRole('button', { name: /^Salida maker/ }).click()
  const detail = page.getByRole('dialog', {
    name: /Salida maker: última evaluación/,
  })
  await expect(detail).toContainText('Orden esperando al mejor precio')
  await expect(detail).toContainText('sigue al mejor precio')
  if (SHOTS)
    await page.screenshot({
      path: `${SHOTS}/salida-${test.info().project.name}.png`,
    })
})
