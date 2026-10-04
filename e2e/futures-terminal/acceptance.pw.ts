import { chromium, expect, test, type Page } from '@playwright/test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer as createNetServer } from 'node:net'
import type { Browser } from '@playwright/test'
import { createServer as createViteServer } from 'vite'
import react from '@vitejs/plugin-react'
import { buildApp } from '../../server/src/app/app.ts'
import { serverConfigFrom } from '../../server/src/platform/config.ts'
import { runtimeEvidencePath } from './evidence-output.ts'

const root = resolve(import.meta.dirname, '../..')
const evidenceDirectory = join(root, 'playwright-artifacts/futures-baseline')

test('actual isolated MOCK terminal acceptance', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'balancita-vt01-'))
  let app: Awaited<ReturnType<typeof buildApp>> | undefined
  let vite: Awaited<ReturnType<typeof createViteServer>> | undefined
  let browser: Browser | undefined
  const pageErrors: string[] = []
  const requests: Array<{ url: string; at: number }> = []
  const frames = new Map<string, Array<Record<string, unknown>>>()
  const commandIds: string[] = []
  try {
    const vitePort = await availablePort()
    const origin = `http://127.0.0.1:${vitePort}`
    app = await buildApp({
      config: serverConfigFrom({
        FUTURES_MODE: 'mock',
        FUTURES_DB_PATH: join(temporaryDirectory, 'account.sqlite'),
        FUTURES_MARKET_DB_PATH: join(temporaryDirectory, 'market.sqlite'),
        GEMINI_SERVER_CORS_ORIGIN: origin,
      }),
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
        proxy: {
          '/api': { target: apiAddress, ws: true, changeOrigin: true },
        },
      },
    })
    await vite.listen()
    browser = await chromium.launch({ channel: 'chrome', headless: true })
    await mkdir(evidenceDirectory, { recursive: true })
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    })
    await context.addInitScript(() => {
      const NativeWebSocket = window.WebSocket
      const sockets: WebSocket[] = []
      class TrackedWebSocket extends NativeWebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols)
          sockets.push(this)
        }
      }
      Object.defineProperty(window, '__vt01Sockets', { value: sockets })
      Object.defineProperty(window, 'WebSocket', {
        configurable: true,
        value: TrackedWebSocket,
      })
    })
    const first = await context.newPage()
    observe(first, 'first', frames, requests, pageErrors, commandIds)
    await first.goto(`${origin}/terminal`)
    await expect(first.getByRole('heading', { name: 'Terminal' })).toBeVisible()
    await expect(
      first.getByText('Último cierre del fixture · USD/BTC'),
    ).toBeVisible()
    await expect(
      first.getByRole('button', { name: 'Iniciar simulación' }),
    ).toBeVisible()
    const actionBackground = await first
      .getByRole('button', { name: 'Iniciar simulación' })
      .evaluate((element) => getComputedStyle(element).backgroundColor)
    expect(actionBackground).not.toBe('rgba(0, 0, 0, 0)')

    const second = await context.newPage()
    observe(second, 'second', frames, requests, pageErrors, commandIds)
    await second.goto(`${origin}/terminal`)
    await expect(
      second.getByRole('heading', { name: 'Terminal' }),
    ).toBeVisible()
    const runId = await first.getByText(/^Run:/).innerText()
    await expect(second.getByText(runId)).toBeVisible()
    await first.screenshot({
      path: join(
        evidenceDirectory,
        'connected-final-mock-desktop-1440x900.png',
      ),
      fullPage: true,
    })

    await first.getByRole('button', { name: 'Iniciar simulación' }).click()
    await expect(first.getByText('long · 0.0099 BTC')).toBeVisible({
      timeout: 15_000,
    })
    await expect(second.getByText('long · 0.0099 BTC')).toBeVisible({
      timeout: 15_000,
    })
    await expect(first.getByText('Ejecución buy')).toBeVisible()
    await expect(
      first.getByText('No disponible durante posición abierta'),
    ).toBeVisible()
    await expect(
      first.getByText('Ruptura alcista C27', { exact: true }),
    ).toBeVisible()
    await first.screenshot({
      path: join(evidenceDirectory, 'connected-final-mock-open-1440x900.png'),
      fullPage: true,
    })

    await first.getByRole('button', { name: 'Pausar entradas' }).click()
    await expect(
      first.getByText(/Resultado durable recibido: committed/),
    ).toBeVisible()
    await first.getByRole('button', { name: 'Reanudar entradas' }).click()
    await expect(
      first.getByText(/Resultado durable recibido: committed/),
    ).toBeVisible()
    await first.getByRole('button', { name: 'Cerrar posición' }).click()
    await expect(
      first.getByText('Sin posición abierta', { exact: true }),
    ).toBeVisible({
      timeout: 15_000,
    })
    await expect(
      second.getByText('Sin posición abierta', { exact: true }),
    ).toBeVisible({
      timeout: 15_000,
    })
    await expect(first.getByText('Ejecución sell')).toBeVisible()
    await expect(
      first.getByText('Incompleto · neto no disponible'),
    ).toBeVisible()

    const firstFills = frames
      .get('first')!
      .filter((frame) => frame.type === 'fill.created')
    const secondFills = frames
      .get('second')!
      .filter((frame) => frame.type === 'fill.created')
    expect(firstFills).toHaveLength(2)
    expect(firstFills.map((frame) => frame.event_id)).toEqual(
      secondFills.map((frame) => frame.event_id),
    )

    await first.evaluate(() => {
      const sockets = (window as Window & { __vt01Sockets: WebSocket[] })
        .__vt01Sockets
      sockets.at(-1)?.close()
    })
    await expect(first.getByText('FLUJO CONECTADO')).toBeVisible({
      timeout: 10_000,
    })
    await expect
      .poll(
        () =>
          frames.get('first')!.filter((frame) => frame.type === 'fill.created')
            .length,
      )
      .toBe(2)
    const economics = await first
      .locator('.connected-terminal__metadata')
      .innerText()
    expect(economics).toContain('Incompleto · neto no disponible')

    const mobile = await context.newPage()
    await mobile.setViewportSize({ width: 390, height: 844 })
    observe(mobile, 'mobile', frames, requests, pageErrors, commandIds)
    await mobile.goto(`${origin}/terminal`)
    await expect(
      mobile.getByRole('heading', { name: 'Terminal' }),
    ).toBeVisible()
    await expect(
      mobile.getByText('Último cierre del fixture · USD/BTC'),
    ).toBeVisible()
    await expect(
      mobile.getByText('Sin posición abierta', { exact: true }),
    ).toBeVisible()
    const mobileOverflow = await mobile.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      offenders: Array.from(document.querySelectorAll<HTMLElement>('*'))
        .map((element) => ({
          tag: element.tagName,
          className: element.className,
          width: Math.ceil(element.getBoundingClientRect().right),
        }))
        .filter((item) => item.width > 390)
        .slice(0, 12),
    }))
    expect(
      mobileOverflow.width,
      JSON.stringify(mobileOverflow.offenders),
    ).toBeLessThanOrEqual(390)
    await mobile.screenshot({
      path: join(evidenceDirectory, 'connected-final-mock-mobile-390x844.png'),
      fullPage: true,
    })

    const beforeIdle = requests.length
    expect(
      requests
        .map((request) => new URL(request.url).pathname)
        .every((pathname) => pathname === '/api/terminal/bootstrap'),
    ).toBe(true)
    expect(beforeIdle).toBe(6)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 60_000))
    expect(requests.length).toBe(beforeIdle)
    expect(pageErrors).toEqual([])

    await first.reload()
    await expect(first.getByRole('heading', { name: 'Terminal' })).toBeVisible()
    await expect(
      first.getByText('Sin posición abierta', { exact: true }),
    ).toBeVisible()
    const commandCountBeforeReloadedPause = commandIds.length
    await first.getByRole('button', { name: 'Pausar entradas' }).click()
    await expect
      .poll(() => commandIds.length)
      .toBe(commandCountBeforeReloadedPause + 1)
    const reloadPauseCommandId = commandIds.at(-1)!
    await expect
      .poll(() =>
        frames
          .get('first')!
          .some(
            (frame) =>
              frame.type === 'command.result' &&
              (frame.data as { command_id?: string }).command_id ===
                reloadPauseCommandId,
          ),
      )
      .toBe(true)
    expect(
      frames
        .get('first')!
        .some(
          (frame) =>
            frame.type === 'protocol.error' &&
            (frame.data as { code?: string }).code === 'stale_state_version',
        ),
    ).toBe(false)
    const malformed = await first.evaluate(async () => {
      const ws = new WebSocket(
        `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/terminal/stream`,
      )
      await new Promise<void>((resolvePromise, reject) => {
        ws.onopen = () => resolvePromise()
        ws.onerror = () =>
          reject(new Error('protocol-error test socket failed'))
      })
      return await new Promise<string>((resolvePromise) => {
        ws.onmessage = (event) => {
          const parsed = JSON.parse(String(event.data)) as {
            type?: string
            data?: { code?: string }
          }
          if (parsed.type === 'protocol.error') {
            ws.close()
            resolvePromise(String(parsed.data?.code))
          }
        }
        ws.send('{')
      })
    })
    expect(malformed).toBe('invalid_message')

    first.once('dialog', (dialog) => void dialog.accept())
    await first.getByRole('button', { name: 'Nueva cuenta/run' }).click()
    const parentRunId = runId.replace(/^Run:\s*/, '')
    await expect
      .poll(() =>
        frames
          .get('first')!
          .some(
            (frame) =>
              frame.type === 'snapshot' && frame.run_id !== parentRunId,
          ),
      )
      .toBe(true)
    const childRunId = String(
      frames
        .get('first')!
        .find(
          (frame) => frame.type === 'snapshot' && frame.run_id !== parentRunId,
        )!.run_id,
    )
    const parentHistory = await first.evaluate(async (run) => {
      const ws = new WebSocket(
        `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/terminal/stream`,
      )
      return await new Promise<Array<{ event_id: string; type: string }>>(
        (resolvePromise, reject) => {
          const timeout = setTimeout(
            () => reject(new Error('history request timed out')),
            10_000,
          )
          ws.onerror = () => reject(new Error('history socket failed'))
          ws.onopen = () =>
            ws.send(
              JSON.stringify({
                schema_version: 1,
                type: 'subscribe',
                run_id: run,
              }),
            )
          ws.onmessage = (event) => {
            const envelope = JSON.parse(String(event.data)) as {
              type: string
              data: Record<string, unknown>
            }
            if (envelope.type === 'snapshot')
              ws.send(
                JSON.stringify({
                  schema_version: 1,
                  type: 'history.request',
                  run_id: run,
                  before_seq: Number.MAX_SAFE_INTEGER,
                  limit: 500,
                }),
              )
            else if (envelope.type === 'history.page') {
              clearTimeout(timeout)
              ws.close()
              resolvePromise(
                envelope.data.events as Array<{
                  event_id: string
                  type: string
                }>,
              )
            }
          }
        },
      )
    }, parentRunId)
    const parentHistoryFillIds = parentHistory
      .filter((event) => event.type === 'fill.created')
      .map((event) => event.event_id)
    expect(parentHistoryFillIds).toEqual(
      firstFills.map((frame) => String(frame.event_id)),
    )
    expect(childRunId).not.toBe(parentRunId)

    const parentSnapshot = frames
      .get('first')!
      .filter(
        (frame) => frame.type === 'snapshot' && frame.run_id === parentRunId,
      )
      .at(-1)!
    const parentState = (
      parentSnapshot.data as { state: Record<string, unknown> }
    ).state
    const actualAccount = parentState.account as Record<string, unknown>
    const json = {
      mode: 'mock',
      run_id: parentRunId,
      child_run_id: childRunId,
      command_ids: commandIds,
      fill_event_ids: firstFills.map((frame) => frame.event_id),
      fill_event_times_ms: firstFills.map(
        (frame) =>
          (frame.data as { fill: { event_time_ms: number } }).fill
            .event_time_ms,
      ),
      two_tabs_same_fill_ids: true,
      parent_history_fill_ids: parentHistoryFillIds,
      after_close: actualAccount,
      restored_position: parentState.position,
      restored_state_version: parentState.state_version,
      idle_http_requests: 0,
      initial_bootstrap_requests: beforeIdle,
      initial_api_paths_only_bootstrap: true,
      page_errors: pageErrors,
      protocol_error: malformed,
    }
    await mkdir(evidenceDirectory, { recursive: true })
    await writeFile(
      runtimeEvidencePath(root),
      `${JSON.stringify(json, null, 2)}\n`,
    )
  } finally {
    await browser?.close()
    await vite?.close()
    await app?.close()
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
})

function observe(
  page: Page,
  name: string,
  frames: Map<string, Array<Record<string, unknown>>>,
  requests: Array<{ url: string; at: number }>,
  pageErrors: string[],
  commandIds: string[],
): void {
  frames.set(name, [])
  page.on('pageerror', (error) => pageErrors.push(`${name}: ${error.message}`))
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/'))
      requests.push({ url: request.url(), at: Date.now() })
  })
  page.on('websocket', (socket) => {
    socket.on('framesent', ({ payload }) => {
      if (typeof payload !== 'string') return
      try {
        const frame = JSON.parse(payload) as Record<string, unknown>
        if (
          frame.type === 'paper.command' &&
          typeof frame.command_id === 'string'
        )
          commandIds.push(frame.command_id)
      } catch {
        // Non-JSON frames are not terminal protocol commands.
      }
    })
    socket.on('framereceived', ({ payload }) => {
      if (typeof payload !== 'string') return
      try {
        frames.get(name)!.push(JSON.parse(payload) as Record<string, unknown>)
      } catch {
        pageErrors.push(`${name}: received a non-JSON WebSocket frame`)
      }
    })
  })
}

async function availablePort(): Promise<number> {
  const server = createNetServer()
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolvePromise())
  })
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('No loopback port assigned.')
  await new Promise<void>((resolvePromise, reject) =>
    server.close((error) => (error ? reject(error) : resolvePromise())),
  )
  return address.port
}
