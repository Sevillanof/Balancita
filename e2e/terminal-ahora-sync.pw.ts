import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { expect, test, type Locator, type Page } from '@playwright/test'

/*
 * AHORA + chart + decisions + history on the REAL gateway, no network mocks.
 * The gateway runs from `gateway-main.ts` with throwaway SQLite files seeded
 * by `e2e/support/seed-gateway-engine.ts` (SYNTHETIC verdicts and candles, a
 * known sequence per product). Its engine follower turns the verdicts into
 * analyses; the Terminal receives them over the real WebSocket. Everything
 * checked here is a fact of that seed: nothing is drawn that did not occur.
 */
const LIVE_PORT = 8789
const GATEWAY = `http://127.0.0.1:${LIVE_PORT}`
const SHOTS = process.env.AHORA_SHOTS_DIR

interface Fact {
  action: string
  reason: string
  bucket: number
  decisionTimeMs: number
  analysisId: string
}
let facts: Record<string, Fact[]> = {}
let waitIds: Record<string, string[]> = {}
let executed: Record<string, { orderId: string; timeMs: number }[]> = {}
let gateway: ChildProcess | null = null

test.describe.configure({ mode: 'serial' })

// Playwright needs the destructured first argument even when it is empty.
// eslint-disable-next-line no-empty-pattern
test.beforeAll(async ({}, info) => {
  test.skip(
    info.project.name !== 'desktop-1440x900',
    'one project only: the gateway owns a fixed port',
  )
  const env = JSON.parse(
    execFileSync('node', ['e2e/support/seed-gateway-engine.ts'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim(),
  ) as Record<string, unknown>
  facts = env.facts as Record<string, Fact[]>
  waitIds = env.waitIds as Record<string, string[]>
  executed = env.executed as typeof executed
  const gatewayEnv = Object.fromEntries(
    Object.entries(env).filter(([key]) => key.startsWith('FUTURES_')),
  ) as Record<string, string>
  gateway = spawn('node', ['server/src/app/gateway-main.ts'], {
    env: {
      ...process.env,
      ...gatewayEnv,
      HOST: '127.0.0.1',
      PORT: String(LIVE_PORT),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  gateway.stderr?.on('data', (chunk) => (stderr += String(chunk)))
  const deadline = Date.now() + 20_000
  for (;;) {
    try {
      const response = await fetch(`${GATEWAY}/api/terminal/bootstrap`)
      if (response.ok) {
        const body = (await response.json()) as {
          engine?: { status?: string }
        }
        if (body.engine?.status === 'running') break
      }
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline)
      throw new Error(`the gateway did not start: ${stderr.slice(-800)}`)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
})

test.afterAll(() => {
  gateway?.kill('SIGTERM')
})

const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16)
// AHORA prints the hour without a leading zero (es-ES long format).
const hmm = (ms: number) => hhmm(ms).replace(/^0/, '')

async function markerPositions(chart: Locator) {
  await expect
    .poll(
      async () => (await chart.getAttribute('data-marker-positions')) ?? '[]',
    )
    .not.toBe('[]')
  return JSON.parse(
    (await chart.getAttribute('data-marker-positions')) ?? '[]',
  ) as { id: string; x: number; y: number }[]
}

/**
 * Click a marker where the chart paints it NOW: the position and the box are
 * read right before the click, from the same published layout.
 */
async function clickMarker(page: Page, chart: Locator, id: string) {
  // The chart has finished moving to the selection it was last given.
  await expect(chart).toHaveAttribute(
    'data-focused-marker',
    (await chart.getAttribute('data-selected-marker')) ?? '',
  )
  // The chart ignores a click that follows another within 500 ms (it waits
  // for a possible double click): move ITS clock past that window.
  await page.clock.fastForward(600)
  // Two frames: the chart has laid out its scales and published them.
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  )
  const box = (await chart.boundingBox())!
  const marker = (await markerPositions(chart)).find((p) => p.id === id)!
  // The canvas registers a pointer before it registers a click on it: arrive
  // (several moves), let one frame paint, then press.
  await page.mouse.move(box.x + marker.x, box.y + marker.y, { steps: 6 })
  await page.evaluate(() => new Promise(requestAnimationFrame))
  await page.mouse.click(box.x + marker.x, box.y + marker.y)
}

async function openTerminal(page: Page) {
  // Time keeps flowing; it only lets a test jump the chart's click window.
  await page.clock.install()
  await page.clock.resume()
  await page.goto('/terminal')
  // The Terminal opens on ETH; these checks are written against the XBT seed.
  await expect(page.getByRole('combobox').first()).toHaveValue('PF_ETHUSD')
  await page.getByRole('combobox').first().selectOption('PF_XBTUSD')
  await expect(page.getByRole('combobox').first()).toHaveValue('PF_XBTUSD')
  await expect(page.getByTestId('source-health')).toContainText(
    'Salud de la fuente · XBT',
  )
  await expect(page.getByTestId('observer-now')).toBeVisible()
  await expect(page.getByTestId('approved-chart-renderer')).toBeVisible()
  // The chart of the switched product has painted its markers.
  await markerPositions(page.getByTestId('approved-chart-renderer'))
}

test('the Terminal opens on ETH, the traded product', async ({ page }) => {
  await page.goto('/terminal')
  await expect(page.getByRole('combobox').first()).toHaveValue('PF_ETHUSD')
  await expect(page.getByTestId('source-health')).toContainText(
    'Salud de la fuente · ETH',
  )
  if (SHOTS)
    await page.screenshot({ path: `${SHOTS}/terminal-abre-en-eth.png` })
})

test('AHORA shows the last real analysis of the stream, with its source', async ({
  page,
}) => {
  await openTerminal(page)
  const newest = facts.PF_XBTUSD!.at(-1)!
  // Newest XBT verdict is a WAIT: espera is a state, not an error.
  expect(newest.action).toBe('WAIT')
  await expect(page.getByTestId('now-action')).toHaveText('Espera')
  const detail = page.getByTestId('now-detail')
  await expect(detail).toContainText('no_directional_proposal')
  await expect(detail).toContainText('Régimen trend')
  await expect(detail).toContainText(hmm(newest.decisionTimeMs))
  await expect(detail).toContainText(/hace \d+ (s|min)/)
  // Current = young AND B1 reads this same verdict as the newest of its source.
  await expect(detail).toHaveAttribute('data-standing', 'current')
  await expect(detail).toContainText('(hora del servidor)')
  await expect(page.getByTestId('now-source')).toContainText(
    'flujo en vivo del gateway; no describe el estado del forward',
  )
  await expect(page.getByTestId('now-source')).toContainText(
    'Espera: el selector no abrió operación',
  )
  // It may only say what the verdict records about its proposals.
  await expect(page.getByTestId('now-source')).toContainText(
    'La única propuesta registrada en el veredicto no fue LONG/SHORT',
  )
  // The health of the source (B1) stays a separate fact next to it, and it is
  // the one of the product on screen (the global one lives in the header).
  await expect(page.getByTestId('source-health')).toContainText(
    'Salud de la fuente · XBT',
  )
  // A WAIT is never presented as a proposal.
  await expect(page.getByTestId('observer-now')).not.toContainText(
    'propuesta, no operación',
  )
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true })
    await page.screenshot({ path: `${SHOTS}/ahora-espera.png` })
  }
})

test('history rows and chart markers are the same decisions and select each other', async ({
  page,
}) => {
  await openTerminal(page)
  const chart = page.getByTestId('approved-chart-renderer')
  const entries = facts.PF_XBTUSD!.filter((f) => f.action !== 'WAIT')
  expect(entries).toHaveLength(3)
  const rows = page.locator('[aria-label="Lista de decisiones"] li button')
  await expect(rows).toHaveCount(3)
  // The visible legend names every kind of marker, apart from each other.
  const legend = page.getByLabel('Leyenda del gráfico')
  await expect(legend).toContainText('propuesta LONG/SHORT')
  await expect(legend).toContainText('W = WAIT')
  await expect(legend).toContainText('EJEC. ejecución paper')
  await expect(legend).toContainText('salida')
  await expect(legend).not.toContainText('entrada larga')
  // Proposals, grouped WAITs and the durable fill: each from a real source.
  const positions = await markerPositions(chart)
  const ids = positions.map((p) => p.id)
  for (const f of entries) expect(ids).toContain(f.analysisId)
  // The executed marker is the durable fill itself (its id is the fill's).
  expect(ids.filter((id) => id.startsWith('fill:'))).toHaveLength(
    executed.PF_XBTUSD!.length,
  )
  const waits = ids.filter((id) => waitIds.PF_XBTUSD!.includes(id))
  // Every other marker is a WAIT group, far fewer than one per minute.
  expect(ids).toHaveLength(entries.length + 1 + waits.length)
  expect(waits.length).toBeGreaterThan(0)
  expect(waits.length).toBeLessThanOrEqual(8)
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true })
    await page.screenshot({
      path: `${SHOTS}/marcadores-propuesta-wait-ejecutada.png`,
    })
    // Same markers with short texts (W×n, EJ L/S); the full text shows on select.
    await page.screenshot({
      path: `${SHOTS}/marcadores-textos-cortos.png`,
    })
    await legend.scrollIntoViewIfNeeded()
    await page.screenshot({ path: `${SHOTS}/leyenda-marcadores.png` })
  }

  // History -> chart: pick the middle (SHORT) row.
  const short = entries.find((f) => f.action === 'SHORT')!
  await page
    .getByRole('button', { name: `Seleccionar análisis ${short.analysisId}` })
    .click()
  await expect(chart).toHaveAttribute('data-selected-marker', short.analysisId)
  const detail = page.getByLabel('Decisión seleccionada')
  await expect(detail).toContainText('SHORT')
  await expect(detail).toContainText(hmm(short.decisionTimeMs))
  // The selected marker is inside the visible chart.
  const box = (await chart.boundingBox())!
  const selected = (await markerPositions(chart)).find(
    (p) => p.id === short.analysisId,
  )!
  expect(selected.x).toBeGreaterThan(0)
  expect(selected.x).toBeLessThan(box.width)

  // Chart -> history: click another marker on the canvas.
  const other = entries.find((f) => f.action === 'LONG')!
  const target = (await markerPositions(chart)).find(
    (p) => p.id === other.analysisId,
  )!
  await clickMarker(page, chart, target.id)
  await expect(chart).toHaveAttribute('data-selected-marker', other.analysisId)
  await expect(
    page.getByRole('button', {
      name: `Seleccionar análisis ${other.analysisId}`,
    }),
  ).toHaveAttribute('aria-pressed', 'true')
  await expect(detail).toContainText('LONG')
  await expect(detail).toContainText(hmm(other.decisionTimeMs))
  if (SHOTS)
    await page.screenshot({ path: `${SHOTS}/seleccion-sincronizada.png` })
})

test('clicking the EJEC. marker on the canvas opens the facts of its fill, apart from every decision', async ({
  page,
}) => {
  await openTerminal(page)
  const chart = page.getByTestId('approved-chart-renderer')
  const sale = executed.PF_XBTUSD![0]!
  const positions = await markerPositions(chart)
  const target = positions.find((p) => p.id.startsWith('fill:'))!
  const pressedBefore = await page
    .locator('[aria-label="Lista de decisiones"] li button')
    .evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute('aria-pressed')),
    )
  const decisionBefore = await chart.getAttribute('data-selected-marker')
  await clickMarker(page, chart, target.id)
  await expect(chart).toHaveAttribute('data-selected-marker', target.id)
  const detail = page.getByLabel('Ejecución seleccionada')
  await expect(detail).toBeVisible()
  await expect(detail.locator('[data-field="fill_id"]')).toContainText(
    target.id,
  )
  await expect(detail.locator('[data-field="order_id"]')).toContainText(
    sale.orderId,
  )
  // Original event time, in UTC (to the millisecond).
  await expect(detail.locator('[data-field="time"]')).toContainText(
    new Date(sale.timeMs).toISOString().replace('T', ' ').replace('Z', ' UTC'),
  )
  await expect(detail.locator('[data-field="quantity"]')).toContainText(/BTC/)
  await expect(detail.locator('[data-field="side"]')).toContainText(
    'LONG (compra)',
  )
  await expect(detail.locator('[data-field="source"]')).toContainText(
    'Histórico · Gateway D',
  )
  await expect(detail).toContainText('no está vinculado a ninguna decisión')
  // No decision row is pressed because of it and its detail is the same.
  expect(
    await page
      .locator('[aria-label="Lista de decisiones"] li button')
      .evaluateAll((buttons) =>
        buttons.map((button) => button.getAttribute('aria-pressed')),
      ),
  ).toEqual(pressedBefore)
  expect(decisionBefore).not.toBe(target.id)
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true })
    await detail.scrollIntoViewIfNeeded()
    await page.screenshot({ path: `${SHOTS}/ejecucion-seleccionada.png` })
  }
  // Picking a decision marker clears the facts of the fill.
  const entries = facts.PF_XBTUSD!.filter((f) => f.action !== 'WAIT')
  const now = (await chart.boundingBox())!
  // The one well inside the chart, not at its edge.
  const other = (await markerPositions(chart))
    .filter(
      (p) =>
        entries.some((f) => f.analysisId === p.id) &&
        p.x > 0 &&
        p.x < now.width,
    )
    .at(-1)!
  await clickMarker(page, chart, other.id)
  await expect(chart).toHaveAttribute('data-selected-marker', other.id)
  await expect(detail).toHaveCount(0)
})

test('a fill and the decision next to it open their own facts, in either order, also zoomed', async ({
  page,
}) => {
  // Nine real clicks over three layouts: slower than the default budget.
  test.slow()
  await openTerminal(page)
  const chart = page.getByTestId('approved-chart-renderer')
  const neighbour = async () => {
    const all = await markerPositions(chart)
    const fill = all.find((p) => p.id.startsWith('fill:'))!
    const near = all
      .filter((p) => !p.id.startsWith('fill:'))
      .sort((a, b) => Math.abs(a.x - fill.x) - Math.abs(b.x - fill.x))[0]!
    return { fill, near }
  }
  const detail = page.getByLabel('Ejecución seleccionada')
  const roundTrip = async () => {
    const { fill, near } = await neighbour()
    // Decision first, then the fill beside it, then the decision again.
    await clickMarker(page, chart, near.id)
    await expect(chart).toHaveAttribute('data-selected-marker', near.id)
    await expect(detail).toHaveCount(0)
    await clickMarker(page, chart, fill.id)
    await expect(chart).toHaveAttribute('data-selected-marker', fill.id)
    await expect(detail).toBeVisible()
    await clickMarker(page, chart, near.id)
    await expect(chart).toHaveAttribute('data-selected-marker', near.id)
    await expect(detail).toHaveCount(0)
    return { fill, near }
  }
  await roundTrip()
  // Zoom out and in: the scale changes between measuring and clicking.
  const box = (await chart.boundingBox())!
  for (const delta of [400, -800]) {
    const before = await chart.getAttribute('data-marker-positions')
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, delta)
    await expect
      .poll(async () => chart.getAttribute('data-marker-positions'))
      .not.toBe(before)
    await roundTrip()
  }
})

test('clicking the bare background of the chart opens neither a decision nor a fill', async ({
  page,
}) => {
  await openTerminal(page)
  const chart = page.getByTestId('approved-chart-renderer')
  const detail = page.getByLabel('Ejecución seleccionada')
  const selectedBefore = await chart.getAttribute('data-selected-marker')
  const box = (await chart.boundingBox())!
  const all = await markerPositions(chart)
  const fill = all.find((p) => p.id.startsWith('fill:'))!
  // Straight below the fill, well inside the plot and far from every glyph.
  const y = Math.min(fill.y + 200, box.height - 60)
  expect(
    all
      .filter((p) => Math.abs(p.x - fill.x) < 60)
      .every((p) => Math.abs(p.y - y) > 60),
  ).toBe(true)
  for (const x of [fill.x, fill.x - 13, fill.x + 13]) {
    await page.clock.fastForward(600)
    await page.mouse.move(box.x + x, box.y + y, { steps: 6 })
    await page.evaluate(() => new Promise(requestAnimationFrame))
    await page.mouse.click(box.x + x, box.y + y)
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    )
    await expect(chart).toHaveAttribute(
      'data-selected-marker',
      selectedBefore ?? '',
    )
    await expect(detail).toHaveCount(0)
  }
})

test('changing product swaps AHORA, rows and markers; nothing leaks across', async ({
  page,
}) => {
  await openTerminal(page)
  const chart = page.getByTestId('approved-chart-renderer')
  await expect(page.getByTestId('now-action')).toHaveText('Espera')
  await page.getByRole('combobox').first().selectOption('PF_ETHUSD')
  const eth = facts.PF_ETHUSD!
  const newest = eth.at(-1)!
  expect(newest.action).toBe('SHORT')
  // ETH's newest verdict is a SHORT proposal, labelled as such.
  await expect(page.getByTestId('now-action')).toHaveText('SHORT')
  await expect(page.getByTestId('source-health')).toContainText(
    'Salud de la fuente · ETH',
  )
  await expect(page.getByTestId('observer-now')).toContainText(
    'propuesta, no operación',
  )
  await expect(page.getByTestId('now-detail')).toContainText(
    'c26_short_reversion',
  )
  await expect(page.getByTestId('now-detail')).toContainText('Régimen range')
  const ethIds = (await markerPositions(chart)).map((p) => p.id)
  for (const f of eth.filter((x) => x.action !== 'WAIT'))
    expect(ethIds).toContain(f.analysisId)
  // ETH has no executed operation in D: no executed marker may appear.
  expect(ethIds.filter((id) => id.startsWith('fill:'))).toEqual([])
  const rows = page.locator('[aria-label="Lista de decisiones"] li button')
  await expect(rows).toHaveCount(2)
  for (const xbt of facts.PF_XBTUSD!.filter((f) => f.action !== 'WAIT'))
    await expect(
      page.getByRole('button', {
        name: `Seleccionar análisis ${xbt.analysisId}`,
      }),
    ).toHaveCount(0)
  await markerPositions(chart)
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/ahora-propuesta.png` })

  // A product with no individual decision in view says so (no engine data
  // outside the seeded products' own verdicts: SOL only has waits).
  await page.getByRole('combobox').first().selectOption('PF_SOLUSD')
  await expect(page.getByTestId('now-action')).toHaveText('Espera')
  await expect(page.getByTestId('now-detail')).toContainText('Régimen trend')
  // SOL only has WAITs: grouped WAIT markers, no proposal and no operation.
  await expect(
    page.getByRole('button', { name: /Seleccionar análisis/ }),
  ).toHaveCount(0)
  const solIds = (await markerPositions(chart)).map((p) => p.id)
  for (const id of solIds) expect(waitIds.PF_SOLUSD).toContain(id)
})

test('without a B1 read AHORA says «Sin confirmar», never a current decision', async ({
  page,
}) => {
  // B1 unreachable: the verdict is young but nothing confirms it.
  await page.route('**/api-live/observability/health', (route) =>
    route.fulfill({ status: 503, body: '{}' }),
  )
  await openTerminal(page)
  await expect(page.getByTestId('last-decision')).toContainText('Sin confirmar')
  await expect(page.getByTestId('now-action')).toHaveCount(0)
  await expect(page.getByTestId('now-blockers')).toContainText('lectura de B1')
  // The product's source health cannot say «Correcto» on a read that failed.
  await expect(page.getByTestId('source-health')).toContainText('Sin confirmar')
  await expect(page.getByTestId('source-health')).not.toContainText('Correcto')
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true })
    await page.screenshot({ path: `${SHOTS}/ahora-sin-confirmar.png` })
  }
})

test('a hole in the candles never moves a marker onto an earlier candle', async ({
  page,
}) => {
  const entries = facts.PF_XBTUSD!.filter((f) => f.action !== 'WAIT')
  const holed = entries.find((f) => f.action === 'SHORT')!
  // Remove from the snapshot the candle of that verdict's bucket (SYNTHETIC
  // gap); the verdict itself stays in the stream and in the history.
  await page.route('**/api-live/terminal/bootstrap*', async (route) => {
    const response = await route.fetch()
    const body = (await response.json()) as {
      terminal_market?: { candles: { time_ms: number }[] }
    }
    if (body.terminal_market)
      body.terminal_market.candles = body.terminal_market.candles.filter(
        (candle) => candle.time_ms !== holed.bucket,
      )
    await route.fulfill({ response, json: body })
  })
  await page.routeWebSocket(/\/terminal\/stream/, (ws) => {
    const server = ws.connectToServer()
    server.onMessage((message) => {
      if (typeof message !== 'string') return ws.send(message)
      try {
        const parsed = JSON.parse(message) as {
          type?: string
          data?: { market?: { candles?: { time_ms: number }[] } }
        }
        const candles = parsed.data?.market?.candles
        if (parsed.type === 'snapshot' && Array.isArray(candles))
          parsed.data!.market!.candles = candles.filter(
            (candle) => candle.time_ms !== holed.bucket,
          )
        ws.send(JSON.stringify(parsed))
      } catch {
        ws.send(message)
      }
    })
  })
  await openTerminal(page)
  const chart = page.getByTestId('approved-chart-renderer')
  const ids = (await markerPositions(chart)).map((p) => p.id)
  const others = entries.filter((f) => f.analysisId !== holed.analysisId)
  for (const f of others) expect(ids).toContain(f.analysisId)
  expect(ids).not.toContain(holed.analysisId)
  // It stays in the history, and says why it is not on the chart.
  await page
    .getByRole('button', { name: `Seleccionar análisis ${holed.analysisId}` })
    .click()
  await expect(page.getByLabel('Decisión seleccionada')).toContainText(
    'no hay vela de su minuto',
  )
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true })
    await page.screenshot({ path: `${SHOTS}/hueco-de-velas.png` })
  }
})

test('an old verdict of a stopped engine is history, never the current state', async ({
  page,
}) => {
  await openTerminal(page)
  await page.getByRole('combobox').first().selectOption('PF_ZECUSD')
  const stale = facts.PF_ZECUSD!.at(-1)!
  expect(stale.action).toBe('LONG')
  await expect(page.getByTestId('last-decision')).toContainText('No disponible')
  await expect(page.getByTestId('now-action')).toHaveCount(0)
  await expect(page.getByTestId('now-detail')).toHaveCount(0)
  const historic = page.getByTestId('now-historic')
  await expect(historic).toContainText('histórica, no es el estado actual')
  await expect(historic).toContainText('LONG')
  await expect(historic).toContainText(hmm(stale.decisionTimeMs))
  await expect(historic).toContainText(/hace (3\d|2\d) min|hace \d+ min/)
  // A LONG that is not current is not presented as a current proposal.
  await expect(page.getByTestId('last-decision')).not.toContainText(
    'propuesta, no operación',
  )
})

test('chart controls on real data: timeframes, zoom, navigation, back to present, indicators', async ({
  page,
}) => {
  const failures: string[] = []
  page.on('response', (response) => {
    if (response.status() >= 400 && response.url().includes('/api-'))
      failures.push(
        `${response.request().method()} ${response.url()} ${response.status()}`,
      )
  })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await openTerminal(page)
  const chart = page.getByTestId('approved-chart-renderer')
  const box = (await chart.boundingBox())!
  const entries = facts.PF_XBTUSD!.filter((f) => f.action !== 'WAIT')
  const xOf = async (id: string) => {
    const found = (
      JSON.parse(
        (await chart.getAttribute('data-marker-positions')) ?? '[]',
      ) as { id: string; x: number }[]
    ).find((p) => p.id === id)
    return found ? found.x : null
  }
  const [first, , last] = entries
  await markerPositions(chart)
  const spread = async () =>
    Number(await xOf(last!.analysisId)) - Number(await xOf(first!.analysisId))

  // Zoom in with the wheel: the markers spread apart.
  const spreadBefore = await spread()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, -600)
  await expect.poll(spread).toBeGreaterThan(spreadBefore + 20)
  // Navigate in time: drag towards older candles, the latest marker moves right.
  const lastX = Number(await xOf(last!.analysisId))
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 250, box.y + box.height / 2, {
    steps: 8,
  })
  await page.mouse.up()
  await expect
    .poll(async () => Number(await xOf(last!.analysisId)))
    .toBeGreaterThan(lastX + 100)
  // Back to the present: the newest candles are in view again, same zoom.
  const zoomedSpread = await spread()
  await page.getByRole('button', { name: 'Volver al presente' }).click()
  await expect
    .poll(async () => Number(await xOf(last!.analysisId)))
    .toBeLessThan(lastX + 100)
  await expect
    .poll(async () => Math.abs((await spread()) - zoomedSpread))
    .toBeLessThan(6)
  expect(Number(await xOf(last!.analysisId))).toBeGreaterThan(box.width / 2)
  expect(Number(await xOf(last!.analysisId))).toBeLessThan(box.width)

  // Timeframes: every marker lands on a real candle of that timeframe.
  for (const label of ['5m', '15m', '1h', '4h', '1m']) {
    await page.getByRole('button', { name: label, exact: true }).click()
    await expect(
      page.getByRole('button', { name: label, exact: true }),
    ).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByText(/Cargando velas/)).toHaveCount(0, {
      timeout: 10_000,
    })
    await expect(chart).toBeVisible()
    const ids = (
      JSON.parse(
        (await chart.getAttribute('data-marker-positions')) ?? '[]',
      ) as { id: string }[]
    ).map((p) => p.id)
    // Never a marker that is not a real proposal, WAIT or executed fill.
    const real = [...entries.map((f) => f.analysisId), ...waitIds.PF_XBTUSD!]
    for (const id of ids)
      expect(real.includes(id) || id.startsWith('fill:')).toBe(true)
    // Same-hour entries stack on one candle; none may be dropped or invented.
    for (const f of entries) expect(ids).toContain(f.analysisId)
    expect(ids.filter((id) => id.startsWith('fill:'))).toHaveLength(
      executed.PF_XBTUSD!.length,
    )
  }

  // Indicators on and off.
  await page.getByText('Indicadores y paneles').click()
  for (const name of ['EMA 9', 'Bollinger 20', 'Donchian 20', 'VWAP diario']) {
    await page.getByRole('checkbox', { name }).check()
    await page.getByRole('checkbox', { name }).uncheck()
  }
  await page.getByRole('checkbox', { name: 'RSI 14' }).check()
  await expect(chart).toBeVisible()
  await page.getByRole('checkbox', { name: 'RSI 14' }).uncheck()
  expect(errors).toEqual([])
  expect(failures.filter((f) => f.includes('/api-live/'))).toEqual([])
})
