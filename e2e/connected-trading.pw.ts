import { expect, test } from '@playwright/test'

const fixtureStart = 1_700_000_000_000

function connectedFixtures() {
  const candle = {
    timestamp: fixtureStart,
    open: 50_000,
    high: 51_000,
    low: 49_000,
    close: 50_500,
    volume: 1,
  }
  const decision = (
    id: string,
    outcome: 'pending' | 'hold',
    direction: 'long' | 'flat',
    eventOffset: number,
  ) => ({
    id,
    instrumentId: 'BTC-EUR',
    eventTime: fixtureStart + eventOffset,
    receivedAt: fixtureStart + eventOffset + 1_000,
    strategyId: 'micro-trend-pullback',
    strategyVersion: 'fixture-version',
    direction,
    outcome,
    reasonCode: null,
    sessionId: null,
    reason: null,
    conditions: [],
  })
  return {
    candle,
    snapshot: {
      candles: [candle],
      collector: { enabled: true, running: false, newest_candle_iso: null },
      paper: {
        enabled: true,
        running: false,
        stream_state: 'connected',
        account: {},
        execution_summary: {},
      },
      orders: [],
      positions: { open: [], closed: [] },
      summary: [],
    },
    decisions: {
      decisions: [
        decision('fixture-event-a', 'pending', 'long', 30_000),
        decision('fixture-event-b', 'hold', 'flat', 45_000),
      ],
    },
  }
}

async function routeConnectedApi(
  page: import('@playwright/test').Page,
  handler: (url: URL, route: import('@playwright/test').Route) => Promise<void>,
) {
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== 'http://127.0.0.1:5174') {
      await route.abort()
      return
    }
    if (url.pathname.startsWith('/api/')) {
      await handler(url, route)
      return
    }
    await route.continue()
  })
}

async function traceFetchLifecycles(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    type FetchTrace = {
      url: string
      method: string
      aborted: boolean
      settled: boolean
    }
    const target = window as Window & { __connectedFetchTrace?: FetchTrace[] }
    target.__connectedFetchTrace = []
    const fetchOriginal = window.fetch.bind(window)
    window.fetch = (input, init = {}) => {
      const url = input instanceof Request ? input.url : String(input)
      const method =
        init.method ?? (input instanceof Request ? input.method : 'GET')
      if (!url.includes('/api/')) return fetchOriginal(input, init)
      const trace: FetchTrace = { url, method, aborted: false, settled: false }
      target.__connectedFetchTrace!.push(trace)
      const signal =
        init.signal ?? (input instanceof Request ? input.signal : undefined)
      signal?.addEventListener(
        'abort',
        () => {
          if (!trace.settled) trace.aborted = true
        },
        { once: true },
      )
      return fetchOriginal(input, init).then(
        (response) => {
          trace.settled = true
          return response
        },
        (cause: unknown) => {
          trace.settled = true
          throw cause
        },
      )
    }
  })
}

async function fetchTrace(page: import('@playwright/test').Page) {
  return page.evaluate(
    () =>
      (
        window as Window & {
          __connectedFetchTrace?: Array<{
            url: string
            method: string
            aborted: boolean
            settled: boolean
          }>
        }
      ).__connectedFetchTrace ?? [],
  )
}

function observeHistoryNetwork(page: import('@playwright/test').Page) {
  const requests: Array<{
    request: import('@playwright/test').Request
    responseStatus?: number
    failure?: string
  }> = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/replay/fast-run/history')
      requests.push({ request })
  })
  page.on('response', (response) => {
    const entry = requests.find(({ request }) => request === response.request())
    if (entry) entry.responseStatus = response.status()
  })
  page.on('requestfailed', (request) => {
    const entry = requests.find((candidate) => candidate.request === request)
    if (entry) entry.failure = request.failure()?.errorText ?? 'unknown failure'
  })
  return requests
}

test('terminal reports unavailable without fallback and recovers only after retry', async ({
  page,
}) => {
  const fixture = connectedFixtures()
  let failing = true
  const apiRequests: string[] = []
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await traceFetchLifecycles(page)
  await page.clock.pauseAt(fixtureStart + 120_000)
  await routeConnectedApi(page, async (url, route) => {
    apiRequests.push(url.pathname)
    if (failing) {
      await route.fulfill({ status: 503, json: { error: 'fixture outage' } })
    } else if (url.pathname === '/api/market/ohlc') {
      await route.fulfill({ json: { candles: [fixture.candle] } })
    } else if (url.pathname === '/api/market/collector/status') {
      await route.fulfill({ json: fixture.snapshot.collector })
    } else if (url.pathname === '/api/paper-trading/status') {
      await route.fulfill({ json: fixture.snapshot.paper })
    } else if (url.pathname === '/api/paper-trading/orders') {
      await route.fulfill({ json: { orders: [] } })
    } else if (url.pathname.includes('/positions')) {
      await route.fulfill({ json: { positions: [] } })
    } else if (url.pathname === '/api/paper-trading/strategies-summary') {
      await route.fulfill({ json: { strategies: [] } })
    } else if (url.pathname === '/api/paper-trading/decisions') {
      await route.fulfill({ json: fixture.decisions })
    } else {
      throw new Error(`Unexpected API request: ${url.pathname}`)
    }
  })
  await page.goto('/terminal')
  await expect(page.getByText('SIN CONEXIÓN', { exact: true })).toBeVisible()
  await expect(
    page.getByText('No disponible', { exact: true }).first(),
  ).toBeVisible()
  await expect(page.getByText(/No se pudo cargar .*\(503\)/)).toBeVisible()
  await expect(page.getByText('BTC-EUR · Demo')).toHaveCount(0)
  const errorRow = page.getByRole('alert').first()
  const retryButton = page.getByRole('button', { name: 'Reintentar' })
  const errorLayout = await errorRow.evaluate((row) => {
    const text = row.querySelector('span')!
    const button = row.querySelector('button')!
    const rect = (element: Element) => {
      const bounds = element.getBoundingClientRect()
      return { left: bounds.left, right: bounds.right, width: bounds.width }
    }
    return {
      row: rect(row),
      text: rect(text),
      button: rect(button),
      scrollWidth: row.scrollWidth,
      clientWidth: row.clientWidth,
    }
  })
  expect(
    errorLayout.button.left,
    JSON.stringify(errorLayout),
  ).toBeGreaterThanOrEqual(0)
  expect(
    errorLayout.button.right,
    JSON.stringify(errorLayout),
  ).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth))
  expect(errorLayout.text.width, JSON.stringify(errorLayout)).toBeGreaterThan(0)
  expect(
    errorLayout.scrollWidth,
    JSON.stringify(errorLayout),
  ).toBeLessThanOrEqual(errorLayout.clientWidth)
  await retryButton.focus()
  await expect(retryButton).toBeFocused()
  await expect(retryButton).toHaveCSS('outline-style', 'solid')
  const endpointKey = (requestUrl: string) => {
    const url = new URL(requestUrl, 'http://127.0.0.1:5174')
    return url.pathname === '/api/market/ohlc'
      ? url.pathname
      : `${url.pathname}${url.search}`
  }
  const expectedEndpoints = new Set([
    '/api/market/ohlc',
    '/api/market/collector/status',
    '/api/paper-trading/status',
    '/api/paper-trading/orders?limit=500',
    '/api/paper-trading/positions?status=open&limit=200',
    '/api/paper-trading/positions?status=closed&limit=200',
    '/api/paper-trading/strategies-summary',
    '/api/paper-trading/decisions?limit=200',
  ])
  const failedSnapshot = await fetchTrace(page)
  const initialGroups = new Map<string, typeof failedSnapshot>()
  for (const entry of failedSnapshot) {
    const key = endpointKey(entry.url)
    initialGroups.set(key, [...(initialGroups.get(key) ?? []), entry])
  }
  expect(new Set(initialGroups.keys())).toEqual(expectedEndpoints)
  for (const entries of initialGroups.values()) {
    expect(entries.filter(({ aborted }) => !aborted)).toHaveLength(1)
    expect(entries.filter(({ aborted }) => aborted).length).toBeLessThanOrEqual(
      1,
    )
  }

  failing = false
  await page.getByRole('button', { name: 'Reintentar' }).click()
  await expect(page.getByText('CONECTADO · PAPER')).toBeVisible()
  await expect(page.getByText('50.500,00 €')).toBeVisible()
  const panel = page.getByRole('region', { name: 'Decisiones paper' })
  const decisionRows = panel.getByRole('table').getByRole('row')
  await expect(decisionRows).toHaveCount(3)
  await expect(panel.getByText('Pendiente, sin ejecución')).toBeVisible()
  await expect(panel.getByText('Sin cambio de exposición')).toBeVisible()
  await expect(panel.getByText('Larga')).toBeVisible()
  await expect(panel.getByText('Plana')).toBeVisible()
  const firstDecision = decisionRows.nth(1).getByRole('button')
  const secondDecision = decisionRows.nth(2).getByRole('button')
  await firstDecision.click()
  await expect(firstDecision).toHaveAttribute('aria-pressed', 'true')
  await expect(secondDecision).toHaveAttribute('aria-pressed', 'false')
  await secondDecision.click()
  await expect(secondDecision).toHaveAttribute('aria-pressed', 'true')
  await expect(firstDecision).toHaveAttribute('aria-pressed', 'false')
  for (const interval of ['5m', '15m', '1h', '1m']) {
    await page.getByRole('button', { name: interval, exact: true }).click()
    await expect(
      page.getByRole('button', { name: interval, exact: true }),
    ).toHaveAttribute('aria-pressed', 'true')
    await expect(decisionRows).toHaveCount(3)
    await expect(panel.getByText('Pendiente, sin ejecución')).toBeVisible()
    await expect(panel.getByText('Sin cambio de exposición')).toBeVisible()
  }
  const completeTrace = await fetchTrace(page)
  expect(completeTrace.every(({ settled }) => settled)).toBeTruthy()
  const completedGroups = new Map<string, typeof completeTrace>()
  for (const entry of completeTrace) {
    const key = endpointKey(entry.url)
    completedGroups.set(key, [...(completedGroups.get(key) ?? []), entry])
  }
  expect(new Set(completedGroups.keys())).toEqual(expectedEndpoints)
  for (const entries of completedGroups.values()) {
    expect(entries.filter(({ aborted }) => !aborted)).toHaveLength(2)
    expect(entries.filter(({ aborted }) => aborted).length).toBeLessThanOrEqual(
      1,
    )
  }
  expect(apiRequests).toHaveLength(
    completeTrace.filter(({ aborted }) => !aborted).length,
  )
  expect(pageErrors).toEqual([])
})

test('terminal retains its last source snapshot across a failed poll and retry', async ({
  page,
}) => {
  const fixture = connectedFixtures()
  let failSnapshot = false
  const requests: string[] = []
  await traceFetchLifecycles(page)
  await page.clock.pauseAt(fixtureStart + 120_000)
  await routeConnectedApi(page, async (url, route) => {
    requests.push(`${route.request().method()} ${url.pathname}`)
    if (url.pathname === '/api/paper-trading/decisions') {
      await route.fulfill({ json: fixture.decisions })
    } else if (failSnapshot) {
      await route.fulfill({ status: 503, json: { error: 'fixture outage' } })
    } else if (url.pathname === '/api/market/ohlc') {
      await route.fulfill({ json: { candles: [fixture.candle] } })
    } else if (url.pathname === '/api/market/collector/status') {
      await route.fulfill({ json: fixture.snapshot.collector })
    } else if (url.pathname === '/api/paper-trading/status') {
      await route.fulfill({ json: fixture.snapshot.paper })
    } else if (url.pathname === '/api/paper-trading/orders') {
      await route.fulfill({ json: { orders: [] } })
    } else if (url.pathname.includes('/positions')) {
      await route.fulfill({ json: { positions: [] } })
    } else if (url.pathname === '/api/paper-trading/strategies-summary') {
      await route.fulfill({ json: { strategies: [] } })
    } else {
      throw new Error(`Unexpected API request: ${url.pathname}`)
    }
  })
  await page.goto('/terminal')
  await expect(page.getByText('CONECTADO · PAPER')).toBeVisible()
  await expect(page.getByText('50.500,00 €')).toBeVisible()
  await expect(
    page.getByText(
      `Respuesta recibida: ${new Date(fixtureStart + 120_000).toLocaleString('es-ES', { timeZone: 'UTC' })} UTC`,
    ),
  ).toBeVisible()
  await expect(page.getByText(/Apertura de última vela:/)).toBeVisible()
  const decisions = page
    .getByRole('region', { name: 'Decisiones paper' })
    .getByRole('table')
    .getByRole('row')
  await expect(decisions).toHaveCount(3)

  failSnapshot = true
  await page.clock.runFor(5_000)
  await expect(page.getByText('SIN CONEXIÓN · PAPER')).toBeVisible()
  await expect(page.getByText('50.500,00 €')).toBeVisible()
  await expect(page.getByText('Datos desactualizados')).toBeVisible()
  await expect(decisions).toHaveCount(3)
  expect(
    requests.filter((request) => request === 'GET /api/market/ohlc').length,
  ).toBeLessThanOrEqual(3)
  const marketTrace = (await fetchTrace(page)).filter(
    (entry) =>
      new URL(entry.url, 'http://127.0.0.1:5174').pathname ===
      '/api/market/ohlc',
  )
  expect(marketTrace.filter(({ aborted }) => !aborted)).toHaveLength(2)

  failSnapshot = false
  await page.getByRole('button', { name: 'Reintentar' }).click()
  await expect(page.getByText('CONECTADO · PAPER')).toBeVisible()
  await expect(page.getByText('50.500,00 €')).toBeVisible()
  await expect(decisions).toHaveCount(3)
  const trace = await fetchTrace(page)
  expect(trace.every(({ settled }) => settled)).toBeTruthy()
  expect(trace.some(({ method }) => method === 'POST')).toBeFalsy()
})

test('terminal polling aborts on navigation and remounts with one active snapshot', async ({
  page,
}) => {
  const fixture = connectedFixtures()
  const marketNetwork: string[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/market/ohlc')
      marketNetwork.push(request.url())
  })
  await traceFetchLifecycles(page)
  await page.clock.pauseAt(fixtureStart + 120_000)
  await routeConnectedApi(page, async (url, route) => {
    if (url.pathname === '/api/market/ohlc') {
      await route.fulfill({ json: { candles: [fixture.candle] } })
    } else if (url.pathname === '/api/market/collector/status') {
      await route.fulfill({ json: fixture.snapshot.collector })
    } else if (url.pathname === '/api/paper-trading/status') {
      await route.fulfill({ json: fixture.snapshot.paper })
    } else if (url.pathname === '/api/paper-trading/orders') {
      await route.fulfill({ json: { orders: [] } })
    } else if (url.pathname.includes('/positions')) {
      await route.fulfill({ json: { positions: [] } })
    } else if (url.pathname === '/api/paper-trading/strategies-summary') {
      await route.fulfill({ json: { strategies: [] } })
    } else if (url.pathname === '/api/paper-trading/decisions') {
      await route.fulfill({ json: fixture.decisions })
    } else if (url.pathname === '/api/replay/fast-run/history') {
      await route.fulfill({ json: { runs: [] } })
    } else {
      throw new Error(`Unexpected API request: ${url.pathname}`)
    }
  })

  await page.goto('/terminal')
  await expect(page.getByText('CONECTADO · PAPER')).toBeVisible()
  const endpoint = '/api/market/ohlc'
  const initial = (await fetchTrace(page)).filter((entry) =>
    new URL(entry.url, 'http://127.0.0.1:5174').pathname.endsWith(endpoint),
  )
  expect(initial.filter(({ aborted }) => !aborted)).toHaveLength(1)
  expect(initial.filter(({ aborted }) => aborted).length).toBeLessThanOrEqual(1)

  await page.getByRole('link', { name: 'Pruebas históricas' }).click()
  await expect(page).toHaveURL(/\/historicos$/)
  const beforeUnmountIdle = marketNetwork.length
  const afterUnmount = (await fetchTrace(page)).filter((entry) =>
    new URL(entry.url, 'http://127.0.0.1:5174').pathname.endsWith(endpoint),
  )
  await page.clock.runFor(15_000)
  expect(await fetchTrace(page)).toHaveLength(afterUnmount.length)
  expect(marketNetwork).toHaveLength(beforeUnmountIdle)
  expect(afterUnmount.every(({ settled }) => settled)).toBeTruthy()

  await page.goto('/demo')
  await expect(page).toHaveURL(/\/demo$/)
  const beforeDemoIdle = marketNetwork.length
  await page.clock.runFor(15_000)
  expect(marketNetwork).toHaveLength(beforeDemoIdle)

  await page.goto('/terminal')
  await expect(page.getByText('CONECTADO · PAPER')).toBeVisible()
  await page.clock.runFor(5_000)
  const remounted = (await fetchTrace(page)).filter((entry) =>
    new URL(entry.url, 'http://127.0.0.1:5174').pathname.endsWith(endpoint),
  )
  expect(remounted.filter(({ aborted }) => !aborted)).toHaveLength(2)
  expect(remounted.filter(({ aborted }) => aborted).length).toBeLessThanOrEqual(
    2,
  )
  await expect
    .poll(async () =>
      (await fetchTrace(page))
        .filter((entry) =>
          new URL(entry.url, 'http://127.0.0.1:5174').pathname.endsWith(
            endpoint,
          ),
        )
        .every(({ settled }) => settled),
    )
    .toBeTruthy()
  expect(
    (await fetchTrace(page)).some(({ method }) => method === 'POST'),
  ).toBeFalsy()
})

test('historical list merges a created run with delayed history and keeps user selection', async ({
  page,
}) => {
  const start = fixtureStart
  const makeRun = (id: string) => ({
    id,
    datasetHash: `hash-${id}`,
    strategyId: 'micro-trend-pullback',
    strategyOwner: 'typescript-native',
    nativeTradeTimestampUnit: 'unix-milliseconds',
    nativeTradeTimestampMeaning: 'simulated-next-15m-candle-open',
    sizingModel: 'cash-all-in.v1',
    initialCashEur: 30,
    window: { start_time: start, end_time: start + 60_000 },
    trades: [],
  })
  const stored = makeRun('stored-old')
  const created = makeRun('created-native')
  const artifactFor = (run: ReturnType<typeof makeRun>) => ({
    schema: 'fast-replay-artifact.v1',
    runId: run.id,
    datasetHash: run.datasetHash,
    source: 'kraken_rest_ohlc',
    engineOwner: 'typescript',
    timestampUnit: 'unix-seconds',
    candleIntervalSeconds: 60,
    candleTimestampSemantics: 'bucket-start',
    cutoffEpochMs: start + 60_000,
    window: run.window,
    candles: [
      {
        timestamp: start / 1000,
        open: 50_000,
        high: 51_000,
        low: 49_000,
        close: 50_500,
        volume: 1,
      },
      {
        timestamp: start / 1000 + 60,
        open: 50_500,
        high: 52_000,
        low: 50_000,
        close: 51_000,
        volume: 1,
      },
    ],
  })
  let releaseHistory!: () => void
  const historyGate = new Promise<void>((resolve) => {
    releaseHistory = resolve
  })
  const pendingPost: Promise<void>[] = []
  let resolvePost!: () => void
  const postGate = new Promise<void>((resolve) => {
    resolvePost = resolve
  })
  const apiRequests: string[] = []
  await traceFetchLifecycles(page)
  const historyNetwork = observeHistoryNetwork(page)
  await routeConnectedApi(page, async (url, route) => {
    apiRequests.push(`${route.request().method()} ${url.pathname}`)
    if (
      url.pathname === '/api/replay/fast-run/history' &&
      route.request().method() === 'GET'
    ) {
      await historyGate
      await route.fulfill({ json: { runs: [stored] } })
    } else if (
      url.pathname === '/api/replay/fast-run' &&
      route.request().method() === 'POST'
    ) {
      pendingPost.push(
        (async () => {
          await postGate
          await route.fulfill({ json: created })
        })(),
      )
    } else if (url.pathname.endsWith('/stored-old/artifact')) {
      await route.fulfill({ json: { artifact: artifactFor(stored) } })
    } else if (url.pathname.endsWith('/created-native/artifact')) {
      await route.fulfill({ json: { artifact: artifactFor(created) } })
    } else {
      throw new Error(`Unexpected historical API request: ${url.pathname}`)
    }
  })
  await page.goto('/historicos')
  const form = page.getByRole('region', { name: 'Nueva prueba histórica' })
  await form
    .getByLabel('Inicio UTC (ISO 8601)')
    .fill(new Date(start).toISOString().replace('.000Z', 'Z'))
  await form
    .getByLabel('Fin UTC (ISO 8601)')
    .fill(new Date(start + 60_000).toISOString().replace('.000Z', 'Z'))
  await form.getByRole('button', { name: 'Ejecutar replay TypeScript' }).click()
  await expect.poll(() => pendingPost.length).toBe(1)
  resolvePost()
  await expect(
    page.getByRole('button', { name: 'created-native', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'Corrida created-native' }),
  ).toBeVisible()
  releaseHistory()
  await expect(
    page.getByRole('button', { name: 'stored-old', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'created-native', exact: true }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'stored-old', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: 'Corrida stored-old' }),
  ).toBeVisible()
  await expect(
    page.getByText('Dataset verificado: kraken_rest_ohlc'),
  ).toBeVisible()
  expect(
    apiRequests.filter((request) => request === 'POST /api/replay/fast-run'),
  ).toHaveLength(1)
  expect(
    apiRequests.some((request) => request.includes('/api/market/ohlc')),
  ).toBeFalsy()
  const historyTrace = (await fetchTrace(page)).filter((entry) =>
    new URL(entry.url, 'http://127.0.0.1:5174').pathname.endsWith('/history'),
  )
  expect(historyTrace.length).toBeLessThanOrEqual(2)
  expect(historyTrace.filter(({ aborted }) => !aborted)).toHaveLength(1)
  expect(
    historyTrace.filter(({ aborted }) => aborted).length,
  ).toBeLessThanOrEqual(1)
  expect(historyTrace.every(({ settled }) => settled)).toBeTruthy()
  expect(
    historyNetwork.filter(({ responseStatus }) => responseStatus === 200),
  ).toHaveLength(1)
  expect(
    historyNetwork.every(
      (entry, index) =>
        entry.responseStatus === 200 ||
        (entry.failure !== undefined && historyTrace[index]?.aborted === true),
    ),
  ).toBeTruthy()
  await Promise.all(pendingPost)
})

test('late native artifact cannot replace the selected Python run or its ownership', async ({
  page,
}) => {
  const start = fixtureStart
  const native = {
    id: 'delayed-native',
    datasetHash: 'hash-delayed-native',
    strategyId: 'micro-trend-pullback',
    strategyOwner: 'typescript-native' as const,
    nativeTradeTimestampUnit: 'unix-milliseconds',
    nativeTradeTimestampMeaning: 'simulated-next-15m-candle-open',
    sizingModel: 'cash-all-in.v1',
    initialCashEur: 30,
    window: { start_time: start, end_time: start + 60_000 },
    trades: [
      {
        side: 'buy' as const,
        timestamp: start + 60_000,
        price: 50_000,
        quantity: 0.001,
      },
    ],
  }
  const python = {
    id: 'selected-python',
    datasetHash: 'hash-selected-python',
    strategyId: 'micro-trend-pullback',
    ledgerOwner: 'python-ledger' as const,
    sizingModel: 'python-long-flat-ledger.v1',
    initialCashEur: 40,
    window: { start_time: start, end_time: start + 60_000 },
    trades: [],
    pythonLedger: {
      ledger: {
        fills: [
          {
            side: 'buy',
            time: start + 60_000,
            price: 50_000,
            qty: 0.001,
            commission: 0.05,
          },
        ],
      },
      executionAudit: {
        fills: [
          {
            fillIndex: 0,
            fillSide: 'buy',
            timingStatus: 'modeled_next_open',
            executionAtMs: start + 60_000,
          },
        ],
      },
    },
  }
  const delayedFailure = {
    ...native,
    id: 'delayed-error',
    datasetHash: 'hash-delayed-error',
  }
  const artifactFor = (run: typeof native | typeof python) => ({
    schema: 'fast-replay-artifact.v1',
    runId: run.id,
    datasetHash: run.datasetHash,
    source: 'kraken_rest_ohlc',
    engineOwner: 'typescript',
    timestampUnit: 'unix-seconds',
    candleIntervalSeconds: 60,
    candleTimestampSemantics: 'bucket-start',
    cutoffEpochMs: start + 60_000,
    window: run.window,
    candles: [
      {
        timestamp: start / 1000,
        open: 50_000,
        high: 51_000,
        low: 49_000,
        close: 50_500,
        volume: 1,
      },
      {
        timestamp: start / 1000 + 60,
        open: 50_500,
        high: 52_000,
        low: 50_000,
        close: 51_000,
        volume: 1,
      },
    ],
  })
  let releaseNative!: () => void
  const nativeGate = new Promise<void>((resolve) => {
    releaseNative = resolve
  })
  let releaseFailure!: () => void
  const failureGate = new Promise<void>((resolve) => {
    releaseFailure = resolve
  })
  let markNativeRequested!: () => void
  const nativeRequested = new Promise<void>((resolve) => {
    markNativeRequested = resolve
  })
  let markFailureRequested!: () => void
  const failureRequested = new Promise<void>((resolve) => {
    markFailureRequested = resolve
  })
  const requests: string[] = []
  await traceFetchLifecycles(page)
  await routeConnectedApi(page, async (url, route) => {
    requests.push(`${route.request().method()} ${url.pathname}`)
    if (url.pathname === '/api/replay/fast-run/history') {
      await route.fulfill({ json: { runs: [native, delayedFailure, python] } })
    } else if (url.pathname.endsWith('/delayed-native/artifact')) {
      markNativeRequested()
      await nativeGate
      await route.fulfill({ json: { artifact: artifactFor(native) } })
    } else if (url.pathname.endsWith('/delayed-error/artifact')) {
      markFailureRequested()
      await failureGate
      await route.fulfill({
        status: 503,
        json: { error: 'late fixture failure' },
      })
    } else if (url.pathname.endsWith('/selected-python/artifact')) {
      await route.fulfill({ json: { artifact: artifactFor(python) } })
    } else {
      throw new Error(`Unexpected historical API request: ${url.pathname}`)
    }
  })
  await page.goto('/historicos')
  await page.getByRole('button', { name: native.id, exact: true }).click()
  await nativeRequested
  await page.getByRole('button', { name: python.id, exact: true }).click()
  await expect(
    page.getByRole('heading', { name: `Corrida ${python.id}` }),
  ).toBeVisible()
  await expect(
    page.getByText('Ledger Python híbrido · señales TypeScript nativas'),
  ).toBeVisible()
  await expect(
    page.getByText(`ID: ${python.id} · Dataset: ${python.datasetHash}`),
  ).toBeVisible()
  await expect(
    page.getByText('Dataset verificado: kraken_rest_ohlc'),
  ).toBeVisible()
  releaseNative()
  await expect(
    page.getByRole('heading', { name: `Corrida ${python.id}` }),
  ).toBeVisible()
  await expect(
    page.getByText(`ID: ${python.id} · Dataset: ${python.datasetHash}`),
  ).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await page
    .getByRole('button', { name: delayedFailure.id, exact: true })
    .click()
  await failureRequested
  await page.getByRole('button', { name: python.id, exact: true }).click()
  await expect(
    page.getByRole('heading', { name: `Corrida ${python.id}` }),
  ).toBeVisible()
  releaseFailure()
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(
    requests.some((request) => request.includes('/api/market/ohlc')),
  ).toBeFalsy()
  expect(
    requests.filter((request) => request.includes('artifact')),
  ).toHaveLength(4)
  expect(requests.some((request) => request.includes('POST'))).toBeFalsy()
  await expect
    .poll(async () => (await fetchTrace(page)).every(({ settled }) => settled))
    .toBeTruthy()
})

test('uncertain replay transport failure advises history check without retrying the POST', async ({
  page,
}) => {
  let postCount = 0
  const apiRequests: string[] = []
  await traceFetchLifecycles(page)
  const historyNetwork = observeHistoryNetwork(page)
  await routeConnectedApi(page, async (url, route) => {
    apiRequests.push(`${route.request().method()} ${url.pathname}`)
    if (url.pathname === '/api/replay/fast-run/history') {
      await route.fulfill({ json: { runs: [] } })
    } else if (
      url.pathname === '/api/replay/fast-run' &&
      route.request().method() === 'POST'
    ) {
      postCount += 1
      await route.abort('failed')
    } else {
      throw new Error(`Unexpected API request: ${url.pathname}`)
    }
  })
  await page.goto('/historicos')
  const form = page.getByRole('region', { name: 'Nueva prueba histórica' })
  await form.getByLabel('Inicio UTC (ISO 8601)').fill('2023-11-14T22:13:20Z')
  await form.getByLabel('Fin UTC (ISO 8601)').fill('2023-11-14T22:14:20Z')
  await form.getByRole('button', { name: 'Ejecutar replay TypeScript' }).click()
  await expect(page.getByRole('alert')).toContainText(
    'Revisá el historial antes de volver a enviarlo',
  )
  await expect(page.getByText('No hay corridas guardadas.')).toBeVisible()
  expect(postCount).toBe(1)
  await expect(page.getByRole('button', { name: 'Reintentar' })).toHaveCount(0)
  expect(
    apiRequests.filter((request) => request === 'POST /api/replay/fast-run'),
  ).toHaveLength(1)
  expect(postCount).toBe(1)
  const historyTrace = (await fetchTrace(page)).filter(
    (entry) =>
      new URL(entry.url, 'http://127.0.0.1:5174').pathname ===
      '/api/replay/fast-run/history',
  )
  expect(historyTrace.length).toBeLessThanOrEqual(2)
  expect(historyTrace.filter(({ aborted }) => !aborted)).toHaveLength(1)
  expect(
    historyTrace.filter(({ aborted }) => aborted).length,
  ).toBeLessThanOrEqual(1)
  expect(historyTrace.every(({ settled }) => settled)).toBeTruthy()
  expect(
    historyNetwork.filter(({ responseStatus }) => responseStatus === 200),
  ).toHaveLength(1)
  expect(
    historyNetwork.every(
      (entry, index) =>
        entry.responseStatus === 200 ||
        (entry.failure !== undefined && historyTrace[index]?.aborted === true),
    ),
  ).toBeTruthy()
})

test('pending replay keeps its submitted parameters when editable form values change', async ({
  page,
}) => {
  const start = fixtureStart
  let releasePost!: () => void
  const postGate = new Promise<void>((resolve) => {
    releasePost = resolve
  })
  let submitted: Record<string, unknown> | null = null
  let postCount = 0
  const created = {
    id: 'captured-native',
    datasetHash: 'hash-captured-native',
    strategyId: 'micro-trend-pullback',
    strategyOwner: 'typescript-native',
    nativeTradeTimestampUnit: 'unix-milliseconds',
    nativeTradeTimestampMeaning: 'simulated-next-15m-candle-open',
    sizingModel: 'cash-all-in.v1',
    initialCashEur: 30,
    window: { start_time: start, end_time: start + 60_000 },
    trades: [],
  }
  const artifact = {
    schema: 'fast-replay-artifact.v1',
    runId: created.id,
    datasetHash: created.datasetHash,
    source: 'kraken_rest_ohlc',
    engineOwner: 'typescript',
    timestampUnit: 'unix-seconds',
    candleIntervalSeconds: 60,
    candleTimestampSemantics: 'bucket-start',
    cutoffEpochMs: start + 60_000,
    window: created.window,
    candles: [
      {
        timestamp: start / 1000,
        open: 50_000,
        high: 51_000,
        low: 49_000,
        close: 50_500,
        volume: 1,
      },
      {
        timestamp: start / 1000 + 60,
        open: 50_500,
        high: 52_000,
        low: 50_000,
        close: 51_000,
        volume: 1,
      },
    ],
  }
  await routeConnectedApi(page, async (url, route) => {
    if (url.pathname === '/api/replay/fast-run/history') {
      await route.fulfill({ json: { runs: [] } })
    } else if (
      url.pathname === '/api/replay/fast-run' &&
      route.request().method() === 'POST'
    ) {
      postCount += 1
      submitted = route.request().postDataJSON() as Record<string, unknown>
      await postGate
      await route.fulfill({ json: created })
    } else if (url.pathname.endsWith('/captured-native/artifact')) {
      await route.fulfill({ json: { artifact } })
    } else {
      throw new Error(`Unexpected historical API request: ${url.pathname}`)
    }
  })
  await page.goto('/historicos')
  const form = page.getByRole('region', { name: 'Nueva prueba histórica' })
  const startInput = form.getByLabel('Inicio UTC (ISO 8601)')
  const endInput = form.getByLabel('Fin UTC (ISO 8601)')
  const cashInput = form.getByLabel('Capital inicial (EUR)')
  const strategyInput = form.getByLabel('Estrategia')
  await startInput.fill(new Date(start).toISOString().replace('.000Z', 'Z'))
  await endInput.fill(
    new Date(start + 60_000).toISOString().replace('.000Z', 'Z'),
  )
  await form.getByRole('button', { name: 'Ejecutar replay TypeScript' }).click()
  await expect.poll(() => postCount).toBe(1)
  expect(submitted).toEqual({
    strategy_id: 'micro-trend-pullback',
    start_time: start,
    end_time: start + 60_000,
    ticket_eur: 30,
  })
  await expect(cashInput).toBeEnabled()
  await expect(startInput).toBeEnabled()
  await expect(endInput).toBeEnabled()
  await expect(strategyInput).toBeEnabled()
  await cashInput.fill('77')
  await startInput.fill(
    new Date(start + 60_000).toISOString().replace('.000Z', 'Z'),
  )
  await endInput.fill(
    new Date(start + 120_000).toISOString().replace('.000Z', 'Z'),
  )
  await strategyInput.selectOption('micro-bollinger-reversion')
  expect(submitted?.ticket_eur).toBe(30)
  expect(submitted?.start_time).toBe(start)
  expect(submitted?.end_time).toBe(start + 60_000)
  expect(submitted?.strategy_id).toBe('micro-trend-pullback')
  releasePost()
  await expect(
    page.getByRole('heading', { name: `Corrida ${created.id}` }),
  ).toBeVisible()
  await expect(page.getByText('Capital inicial: 30,00 €')).toBeVisible()
  await expect(cashInput).toHaveValue('77')
  await expect(startInput).toHaveValue(
    new Date(start + 60_000).toISOString().replace('.000Z', 'Z'),
  )
  await expect(endInput).toHaveValue(
    new Date(start + 120_000).toISOString().replace('.000Z', 'Z'),
  )
  await expect(strategyInput).toHaveValue('micro-bollinger-reversion')
  expect(postCount).toBe(1)
})

test('fixture-backed saved history renders only verified fill times', async ({
  page,
}) => {
  const start = 1_700_000_000_000
  const run = {
    id: 'fixture-native',
    datasetHash: 'fixture-hash',
    strategyId: 'micro-trend-pullback',
    strategyOwner: 'typescript-native',
    nativeTradeTimestampUnit: 'unix-milliseconds',
    nativeTradeTimestampMeaning: 'simulated-next-15m-candle-open',
    sizingModel: 'cash-all-in.v1',
    initialCashEur: 30,
    window: { start_time: start, end_time: start + 120_000 },
    trades: [
      {
        side: 'buy',
        timestamp: start + 60_000,
        price: 50_000,
        quantity: 0.001,
      },
      {
        side: 'sell',
        timestamp: start + 61_000_000,
        price: 51_000,
        quantity: 0.001,
      },
    ],
  }
  const artifact = {
    schema: 'fast-replay-artifact.v1',
    runId: run.id,
    datasetHash: run.datasetHash,
    source: 'kraken_rest_ohlc',
    engineOwner: 'typescript',
    timestampUnit: 'unix-seconds',
    candleIntervalSeconds: 60,
    candleTimestampSemantics: 'bucket-start',
    cutoffEpochMs: start + 120_000,
    window: run.window,
    candles: [
      {
        timestamp: start / 1000,
        open: 50_000,
        high: 51_000,
        low: 49_000,
        close: 50_500,
        volume: 1,
      },
      {
        timestamp: start / 1000 + 60,
        open: 50_500,
        high: 52_000,
        low: 50_000,
        close: 51_000,
        volume: 1,
      },
      {
        timestamp: start / 1000 + 120,
        open: 51_000,
        high: 52_000,
        low: 50_000,
        close: 51_000,
        volume: 1,
      },
    ],
  }
  const requests: string[] = []
  await traceFetchLifecycles(page)
  const historyNetwork = observeHistoryNetwork(page)
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.hostname !== '127.0.0.1' || url.port !== '5174') {
      await route.abort()
      return
    }
    if (url.pathname === '/api/replay/fast-run/history') {
      requests.push(url.pathname)
      await route.fulfill({ json: { runs: [run] } })
      return
    }
    if (url.pathname.endsWith(`/history/${run.id}/artifact`)) {
      requests.push(url.pathname)
      await route.fulfill({ json: { artifact } })
      return
    }
    if (url.pathname.startsWith('/api/')) {
      await route.fulfill({
        status: 503,
        json: { error: 'fixture unavailable' },
      })
      return
    }
    await route.continue()
  })
  await page.goto('/historicos')
  await page.getByRole('button', { name: run.id, exact: true }).click()
  await expect(page.getByText(/Fills simulados a la apertura/)).toBeVisible()
  await expect(
    page.getByRole('cell', { name: '2023-11-14T22:14:20.000Z' }),
  ).toBeVisible()
  await expect(
    page.getByRole('cell', { name: 'No disponible' }).first(),
  ).toBeVisible()
  await expect(
    page.getByText(/1 fills tienen una hora no disponible/),
  ).toBeVisible()
  expect(
    requests.filter((path) => path === '/api/replay/fast-run/history').length,
  ).toBeLessThanOrEqual(2)
  expect(requests).toContain(`/api/replay/fast-run/history/${run.id}/artifact`)
  const historyTrace = (await fetchTrace(page)).filter(
    (entry) =>
      new URL(entry.url, 'http://127.0.0.1:5174').pathname ===
      '/api/replay/fast-run/history',
  )
  expect(historyTrace.length).toBeLessThanOrEqual(2)
  expect(historyTrace.filter(({ aborted }) => !aborted)).toHaveLength(1)
  expect(
    historyTrace.filter(({ aborted }) => aborted).length,
  ).toBeLessThanOrEqual(1)
  expect(historyTrace.every(({ settled }) => settled)).toBeTruthy()
  expect(
    historyNetwork.filter(({ responseStatus }) => responseStatus === 200),
  ).toHaveLength(1)
  expect(
    historyNetwork.every(
      (entry, index) =>
        entry.responseStatus === 200 ||
        (entry.failure !== undefined && historyTrace[index]?.aborted === true),
    ),
  ).toBeTruthy()
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('connected terminal and saved native/Python runs remain usable at this viewport', async ({
  page,
}, testInfo) => {
  const consoleErrors: string[] = []
  page.on('pageerror', (error) => consoleErrors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.hostname === '127.0.0.1' && ['5174', '8787'].includes(url.port)) {
      await route.continue()
      return
    }
    await route.abort()
  })

  const historyResponse = await page.request
    .get('http://127.0.0.1:8787/api/replay/fast-run/history?limit=50')
    .catch(() => null)
  test.skip(
    !historyResponse?.ok(),
    'Requires the already-running local backend.',
  )
  if (historyResponse === null) return
  expect(historyResponse.ok()).toBeTruthy()
  const history = (await historyResponse.json()) as {
    runs: Array<{ id: string; ledgerOwner?: string }>
  }
  const withVerifiedArtifact = async (owner: 'native' | 'python') => {
    for (const run of history.runs.filter((candidate) =>
      owner === 'python'
        ? candidate.ledgerOwner === 'python-ledger'
        : candidate.ledgerOwner !== 'python-ledger',
    )) {
      const response = await page.request.get(
        `http://127.0.0.1:8787/api/replay/fast-run/history/${encodeURIComponent(run.id)}/artifact`,
      )
      if (response.ok()) return run
    }
    return undefined
  }
  const native = await withVerifiedArtifact('native')
  const python = await withVerifiedArtifact('python')
  expect(
    native,
    'local backend should provide a stored native run',
  ).toBeTruthy()
  expect(
    python,
    'local backend should provide a stored Python-ledger run',
  ).toBeTruthy()

  await page.goto('/terminal')
  await expect(
    page.getByRole('heading', { name: 'Terminal BTC-EUR' }),
  ).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'Estado del motor' }),
  ).toBeVisible()
  await expect(
    page.getByRole('navigation', { name: 'Navegación conectada' }),
  ).toBeVisible()
  await page.screenshot({
    path: `playwright-artifacts/connected-terminal-${testInfo.project.name}.png`,
    fullPage: true,
  })

  await page.getByRole('link', { name: 'Pruebas históricas' }).click()
  await expect(page).toHaveURL(/\/historicos$/)
  await expect(
    page.getByRole('heading', { name: 'Pruebas históricas' }),
  ).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'Nueva prueba histórica' }),
  ).toBeVisible()
  for (const run of [native!, python!]) {
    const row = page.getByRole('button', { name: run.id, exact: true })
    await expect(row).toBeVisible()
    await row.click()
    await expect(
      page.getByRole('heading', { name: `Corrida ${run.id}` }),
    ).toBeVisible()
    await expect(
      page.getByText(/Dataset verificado: kraken_rest_ohlc/),
    ).toBeVisible()
    await expect(page.getByRole('alert')).toHaveCount(0)
  }

  const layout = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
    bounds: [
      ...document.querySelectorAll(
        '.demo-shell, .demo-shell__main, .connected-terminal__layout, .connected-terminal__panel, .chart__container',
      ),
    ].map((element) => ({
      className: element.className,
      left: Math.floor(element.getBoundingClientRect().left),
      right: Math.ceil(element.getBoundingClientRect().right),
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    })),
    overflowing: [...document.querySelectorAll('body *')]
      .map((element) => ({
        tag: element.tagName,
        className:
          typeof element.className === 'string' ? element.className : '',
        right: Math.ceil(element.getBoundingClientRect().right),
      }))
      .filter((element) => element.right > window.innerWidth + 1)
      .slice(0, 8),
    tables: [
      ...document.querySelectorAll('.connected-terminal__table-wrap'),
    ].map((element) => ({
      left: Math.floor(element.getBoundingClientRect().left),
      right: Math.ceil(element.getBoundingClientRect().right),
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    })),
  }))
  expect(layout.documentWidth, JSON.stringify(layout)).toBeLessThanOrEqual(
    layout.viewportWidth,
  )
  if (testInfo.project.name === 'mobile-390x844') {
    expect(
      layout.tables.some((table) => table.scrollWidth > table.clientWidth),
    ).toBeTruthy()
  }
  await page.screenshot({
    path: `playwright-artifacts/connected-history-${testInfo.project.name}.png`,
    fullPage: true,
  })
  expect(consoleErrors).toEqual([])
})

test('submits one native and one Python replay against verified stored candles', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop-1440x900',
    'Mutating local replay proof runs once per browser matrix.',
  )
  test.skip(
    process.env.BALANCITA_CONNECTED_RUNTIME_POST !== '1',
    'Explicit opt-in required to persist two local replay simulations.',
  )
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.hostname === '127.0.0.1' && ['5174', '8787'].includes(url.port)) {
      await route.continue()
      return
    }
    await route.abort()
  })

  const latestQuery = await page.request
    .get(
      `http://127.0.0.1:8787/api/market/ohlc?start_time=${Date.now() - 12 * 60 * 60 * 1000}&end_time=${Date.now()}`,
    )
    .catch(() => null)
  test.skip(
    !latestQuery?.ok(),
    'Requires verified OHLC from the local backend.',
  )
  if (latestQuery === null) return
  expect(latestQuery.ok()).toBeTruthy()
  const stored = (await latestQuery.json()) as {
    candles: Array<{ timestamp: number }>
  }
  const candles = stored.candles.slice(-181)
  expect(candles).toHaveLength(181)
  expect(
    candles.every(
      (candle, index) =>
        index === 0 ||
        candle.timestamp - candles[index - 1]!.timestamp === 60_000,
    ),
  ).toBeTruthy()
  const start = candles[0]!.timestamp
  const end = candles.at(-1)!.timestamp
  const historyBefore = await page.request.get(
    'http://127.0.0.1:8787/api/replay/fast-run/history?limit=50',
  )
  const before = (await historyBefore.json()) as { runs: Array<{ id: string }> }
  const existingIds = new Set(before.runs.map(({ id }) => id))

  await page.goto('/historicos')
  const form = page.getByRole('region', { name: 'Nueva prueba histórica' })
  await form
    .getByLabel('Inicio UTC (ISO 8601)')
    .fill(new Date(start).toISOString().replace('.000Z', 'Z'))
  await form
    .getByLabel('Fin UTC (ISO 8601)')
    .fill(new Date(end).toISOString().replace('.000Z', 'Z'))

  for (const owner of ['typescript-native', 'python-ledger'] as const) {
    await form.getByLabel('Motor').selectOption(owner)
    const endpoint =
      owner === 'typescript-native'
        ? '/api/replay/fast-run'
        : '/api/replay/python-ledger-run'
    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().endsWith(endpoint) &&
        response.request().method() === 'POST',
    )
    await form
      .getByRole('button', {
        name:
          owner === 'typescript-native'
            ? 'Ejecutar replay TypeScript'
            : 'Ejecutar replay Python ledger',
      })
      .click()
    const response = await responsePromise
    const payload = (await response.json()) as {
      id?: string
      ledgerOwner?: string
      strategyId?: string
      artifact?: { runId?: string; datasetHash?: string; candles?: unknown[] }
      error?: { message?: string }
    }
    expect(response.ok(), payload.error?.message).toBeTruthy()
    expect(payload.id).toBeTruthy()
    expect(existingIds.has(payload.id!)).toBeFalsy()
    expect(payload.artifact?.runId).toBe(payload.id)
    expect(payload.artifact?.datasetHash).toBeTruthy()
    expect(payload.artifact?.candles?.length).toBe(181)
    expect(payload.ledgerOwner === 'python-ledger').toBe(
      owner === 'python-ledger',
    )
    await expect(
      page.getByRole('heading', { name: `Corrida ${payload.id}` }),
    ).toBeVisible()
    await expect(
      page.getByText(/Dataset verificado: kraken_rest_ohlc/),
    ).toBeVisible()
    const historyAfter = await page.request.get(
      `http://127.0.0.1:8787/api/replay/fast-run/history?limit=50`,
    )
    const after = (await historyAfter.json()) as { runs: Array<{ id: string }> }
    expect(after.runs.some(({ id }) => id === payload.id)).toBeTruthy()
    const artifactResponse = await page.request.get(
      `http://127.0.0.1:8787/api/replay/fast-run/history/${encodeURIComponent(payload.id!)}/artifact`,
    )
    expect(artifactResponse.ok()).toBeTruthy()
    const frozen = (await artifactResponse.json()) as {
      artifact?: { runId?: string; datasetHash?: string }
    }
    expect(frozen.artifact?.runId).toBe(payload.id)
    expect(frozen.artifact?.datasetHash).toBe(payload.artifact?.datasetHash)
    await page.screenshot({
      path: `playwright-artifacts/connected-created-${owner}.png`,
      fullPage: true,
    })
  }
})
