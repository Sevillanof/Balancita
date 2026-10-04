import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { chromium, expect, test, type Browser } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer as createNetServer } from 'node:net'
import { createServer as createViteServer } from 'vite'
import react from '@vitejs/plugin-react'
import { buildApp } from '../../server/src/app/app.ts'
import { serverConfigFrom } from '../../server/src/platform/config.ts'
import type { FuturesSocket } from '../../server/src/features/kraken-futures/futures-market.ts'

const root = resolve(import.meta.dirname, '../..')
const evidenceDirectory = join(root, 'playwright-artifacts/futures-paper-live')

class InjectedPublicSocket implements FuturesSocket {
  static latest: InjectedPublicSocket | undefined
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  private readonly output: string
  private publishSequence = 0

  constructor(output: string) {
    this.output = output
    InjectedPublicSocket.latest = this
    queueMicrotask(() => this.onopen?.())
  }

  publishFixture(): void {
    const now = Date.now()
    this.publishSequence += 1
    const sequence = this.publishSequence * 100
    for (const message of [
      {
        feed: 'book_snapshot',
        product_id: 'PF_XBTUSD',
        seq: sequence + 10,
        timestamp: now,
        bids: [{ price: '90000', qty: '0.5' }],
        asks: [{ price: '90001', qty: '0.5' }],
      },
      {
        feed: 'ticker',
        product_id: 'PF_XBTUSD',
        seq: sequence + 20,
        time: now,
        last: '90000.5',
        markPrice: '90000',
        suspended: false,
      },
      {
        feed: 'book',
        product_id: 'PF_XBTUSD',
        seq: sequence + 11,
        timestamp: now + 1,
        side: 'buy',
        price: '90000',
        qty: '0.6',
      },
      {
        feed: 'trade',
        product_id: 'PF_XBTUSD',
        uid: `offline-terminal-trade-${this.publishSequence}`,
        side: 'sell',
        type: 'fill',
        seq: sequence + 21,
        time: now + 1,
        qty: '0.0002',
        price: '90000',
      },
    ]) {
      const raw = JSON.stringify(message)
      appendFileSync(
        this.output,
        `${JSON.stringify({ captured_at: Date.now(), raw })}\n`,
      )
      this.onmessage?.({ data: raw })
    }
  }

  send(): void {}
  close(): void {
    this.onclose?.()
  }
}

class CapturedPublicSocket implements FuturesSocket {
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  private readonly socket: WebSocket

  constructor(url: string, capture: (record: Record<string, unknown>) => void) {
    this.socket = new WebSocket(url)
    this.socket.addEventListener('open', () => this.onopen?.())
    this.socket.addEventListener('message', (event) => {
      const raw =
        typeof event.data === 'string' ? event.data : String(event.data)
      capture({ kind: 'websocket_frame', url, received_at: Date.now(), raw })
      this.onmessage?.({ data: event.data })
    })
    this.socket.addEventListener('error', () => this.onerror?.())
    this.socket.addEventListener('close', () => this.onclose?.())
  }

  send(message: string): void {
    this.socket.send(message)
  }

  close(): void {
    this.socket.close()
  }
}

test('isolated PAPER_LIVE terminal renders injected public evidence honestly', async () => {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), 'balancita-paper-live-'),
  )
  mkdirSync(evidenceDirectory, { recursive: true })
  const rawPath = join(evidenceDirectory, 'offline-raw-frames.jsonl')
  const vitePort = await availablePort()
  const origin = `http://127.0.0.1:${vitePort}`
  let app: Awaited<ReturnType<typeof buildApp>> | undefined
  let vite: Awaited<ReturnType<typeof createViteServer>> | undefined
  let browser: Browser | undefined
  const errors: string[] = []
  try {
    app = await buildApp({
      config: serverConfigFrom({
        FUTURES_MODE: 'paper_live',
        FUTURES_DB_PATH: join(temporaryDirectory, 'account.sqlite'),
        FUTURES_MARKET_DB_PATH: join(temporaryDirectory, 'market.sqlite'),
        GEMINI_SERVER_CORS_ORIGIN: origin,
        KRAKEN_REST_OHLC_WORKER_ENABLED: 'false',
      }),
      overrides: {
        futuresPublicCatalog: async () => ({
          instruments: [
            {
              symbol: 'PF_XBTUSD',
              type: 'flexible_futures',
              pair: 'BTC:USD',
              base: 'BTC',
              quote: 'USD',
              contractSize: '1',
              tickSize: '1',
              contractValueTradePrecision: 4,
              tradeable: true,
              isExpired: false,
            },
          ],
        }),
        futuresSocketFactory: () => new InjectedPublicSocket(rawPath),
        futuresFundingFetch: async () =>
          new Response('unavailable', { status: 503 }),
      } as never,
    })
    await app.ready()
    const apiAddress = await app.listen({ port: 0, host: '127.0.0.1' })
    vite = await createViteServer({
      configFile: false,
      root,
      plugins: [react()],
      appType: 'spa',
      server: {
        host: '127.0.0.1',
        port: vitePort,
        strictPort: true,
        proxy: { '/api': { target: apiAddress, ws: true, changeOrigin: true } },
      },
    })
    await vite.listen()
    browser = await chromium.launch({ channel: 'chrome', headless: true })
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    })
    const page = await context.newPage()
    page.on('pageerror', (error) => errors.push(error.message))
    const requests: string[] = []
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname
      if (path.startsWith('/api/')) requests.push(path)
    })
    await page.goto(`${origin}/terminal`)
    await expect(page.getByRole('heading', { name: 'Terminal' })).toBeVisible()
    await expect(page.getByText('FLUJO CONECTADO')).toBeVisible()
    InjectedPublicSocket.latest?.publishFixture()
    await expect(
      page.getByText('MERCADO REAL · OPERACIONES SIMULADAS', { exact: true }),
    ).toBeVisible()
    await expect(page.getByText('Último trade público · USD/BTC')).toBeVisible()
    await expect(page.getByText(/90\.000,00/)).toBeVisible()
    await expect(
      page.getByText(/Profundidad bid\/ask: no expuesta/),
    ).toBeVisible()
    await expect(page.getByText(/Financiación: desconocida/)).toBeVisible()
    await expect(
      page.getByText(
        /Warm-up: el motor aún no ha recibido evidencia suficiente/,
      ),
    ).toBeVisible()
    await expect(
      page.getByText(/Evento .* UTC · recibido .* UTC · hace .* s/),
    ).toBeVisible()
    await expect(page.getByText('Incompleto', { exact: true })).toBeVisible()
    await page.screenshot({
      path: join(evidenceDirectory, 'paper-live-offline-desktop-1440x900.png'),
      fullPage: true,
    })
    const mobile = await context.newPage()
    await mobile.setViewportSize({ width: 390, height: 844 })
    mobile.on('pageerror', (error) => errors.push(error.message))
    await mobile.goto(`${origin}/terminal`)
    await expect(mobile.getByText('FLUJO CONECTADO')).toBeVisible()
    InjectedPublicSocket.latest?.publishFixture()
    await expect(
      mobile.getByText('Último trade público · USD/BTC'),
    ).toBeVisible()
    const width = await mobile.evaluate(
      () => document.documentElement.scrollWidth,
    )
    expect(width).toBeLessThanOrEqual(390)
    await mobile.screenshot({
      path: join(evidenceDirectory, 'paper-live-offline-mobile-390x844.png'),
      fullPage: true,
    })
    await expect
      .poll(
        () =>
          requests.filter((path) => path === '/api/terminal/bootstrap').length,
      )
      .toBe(2)
    expect(requests.every((path) => path === '/api/terminal/bootstrap')).toBe(
      true,
    )
    expect(errors).toEqual([])
  } finally {
    await browser?.close()
    await vite?.close()
    await app?.close()
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
})

test('one bounded anonymous PAPER_LIVE public capture', async () => {
  test.skip(
    process.env.BALANCITA_PUBLIC_FUTURES_ACCEPTANCE !== '1',
    'Opt in explicitly to the one 45-second anonymous public capture.',
  )
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), 'balancita-paper-live-public-'),
  )
  mkdirSync(evidenceDirectory, { recursive: true })
  const rawPath = join(evidenceDirectory, 'public-raw-evidence.jsonl')
  const startedAt = Date.now()
  const audit = {
    started_at: new Date(startedAt).toISOString(),
    duration_ms: 45_000,
    raw_path: rawPath,
  }
  writeFileSync(rawPath, `${JSON.stringify({ kind: 'capture', ...audit })}\n`)
  let bytesWritten = 0
  const capture = (record: Record<string, unknown>): void => {
    if (Date.now() > startedAt + 45_000) return
    const line = `${JSON.stringify(record)}\n`
    const bytes = Buffer.byteLength(line)
    if (bytesWritten + bytes > 4 * 1024 * 1024)
      throw new Error('Public raw evidence exceeded the 4 MiB capture bound.')
    appendFileSync(rawPath, line)
    bytesWritten += bytes
  }
  const nativeFetch = globalThis.fetch
  const captureFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const response = await nativeFetch(input, init)
    const body = await response.text()
    capture({
      kind: 'http_response',
      url: String(input),
      method: init?.method ?? 'GET',
      requested_at: Date.now(),
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      raw: body,
    })
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
  const vitePort = await availablePort()
  const origin = `http://127.0.0.1:${vitePort}`
  let app: Awaited<ReturnType<typeof buildApp>> | undefined
  let vite: Awaited<ReturnType<typeof createViteServer>> | undefined
  let browser: Browser | undefined
  const errors: string[] = []
  const apiRequests: string[] = []
  try {
    globalThis.fetch = captureFetch
    app = await buildApp({
      config: serverConfigFrom({
        FUTURES_MODE: 'paper_live',
        FUTURES_DB_PATH: join(temporaryDirectory, 'account.sqlite'),
        FUTURES_MARKET_DB_PATH: join(temporaryDirectory, 'market.sqlite'),
        GEMINI_SERVER_CORS_ORIGIN: origin,
        KRAKEN_REST_OHLC_WORKER_ENABLED: 'false',
      }),
      overrides: {
        futuresSocketFactory: (url) => new CapturedPublicSocket(url, capture),
        futuresFundingFetch: captureFetch,
      } as never,
    })
    await app.ready()
    const apiAddress = await app.listen({ port: 0, host: '127.0.0.1' })
    vite = await createViteServer({
      configFile: false,
      root,
      plugins: [react()],
      appType: 'spa',
      server: {
        host: '127.0.0.1',
        port: vitePort,
        strictPort: true,
        proxy: { '/api': { target: apiAddress, ws: true, changeOrigin: true } },
      },
    })
    await vite.listen()
    browser = await chromium.launch({ channel: 'chrome', headless: true })
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    })
    const page = await context.newPage()
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname
      if (path.startsWith('/api/')) apiRequests.push(path)
    })
    await page.goto(`${origin}/terminal`)
    await expect(page.getByRole('heading', { name: 'Terminal' })).toBeVisible()
    const mobile = await context.newPage()
    await mobile.setViewportSize({ width: 390, height: 844 })
    mobile.on('pageerror', (error) => errors.push(error.message))
    await mobile.goto(`${origin}/terminal`)
    await expect(
      mobile.getByRole('heading', { name: 'Terminal' }),
    ).toBeVisible()

    await new Promise((resolvePromise) =>
      setTimeout(resolvePromise, Math.max(0, startedAt + 45_000 - Date.now())),
    )
    await expect(
      page.getByText(/Último trade público|Último ticker público/),
    ).toBeVisible()
    await page.screenshot({
      path: join(evidenceDirectory, 'paper-live-public-desktop-1440x900.png'),
      fullPage: true,
    })
    await mobile.screenshot({
      path: join(evidenceDirectory, 'paper-live-public-mobile-390x844.png'),
      fullPage: true,
    })
    const viewportOverflow = await mobile.evaluate(
      () => document.documentElement.scrollWidth,
    )
    expect(viewportOverflow).toBeLessThanOrEqual(390)
    expect(errors).toEqual([])
    expect(
      apiRequests.every((path) => path === '/api/terminal/bootstrap'),
    ).toBe(true)
    const receipt = {
      ...audit,
      finished_at: new Date().toISOString(),
      duration_ms_observed: Date.now() - startedAt,
      raw_bytes: bytesWritten,
      api_requests: apiRequests,
      screenshots: [
        'paper-live-public-desktop-1440x900.png',
        'paper-live-public-mobile-390x844.png',
      ],
      page_errors: errors,
    }
    appendFileSync(
      rawPath,
      `${JSON.stringify({ kind: 'receipt', ...receipt })}\n`,
    )
  } catch (error) {
    capture({
      kind: 'capture_error',
      at: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  } finally {
    globalThis.fetch = nativeFetch
    await browser?.close()
    await vite?.close()
    await app?.close()
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
})

async function availablePort(): Promise<number> {
  const server = createNetServer()
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolvePromise())
  })
  const address = server.address()
  if (address === null || typeof address === 'string')
    throw new Error('Could not allocate a loopback port.')
  await new Promise<void>((resolvePromise, reject) =>
    server.close((error) => (error ? reject(error) : resolvePromise())),
  )
  return address.port
}
