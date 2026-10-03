import { createHash } from 'node:crypto'
import { chromium, expect, test, type Browser } from '@playwright/test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer as createViteServer } from 'vite'
import react from '@vitejs/plugin-react'
import { buildApp } from '../../server/src/app/app.ts'
import { serverConfigFrom } from '../../server/src/platform/config.ts'
import { availablePort, createRecordedSource } from './replay-source-fixture.ts'

const root = resolve(import.meta.dirname, '../..')
const evidenceDirectory = join(root, 'playwright-artifacts/futures-baseline')
type ReplayBootstrap = {
  readonly mode: string
  readonly active_run_id: string
  readonly source_manifest: { readonly source_file_hash: string }
}

type ReplayExport = {
  readonly schema_version: string
  readonly verified: boolean
  readonly run_id: string
  readonly manifest_hash: string
  readonly semantic_hash: string
  readonly source_hash: string
  readonly source_file_hash: string
  readonly comparison: { readonly equal: boolean }
  readonly economic_export: {
    readonly manifest_hash: string
    readonly inputs: readonly unknown[]
  }
  readonly batch_verification: { readonly inputs: readonly unknown[] }
}

test('actual source-backed REPLAY terminal and verified export', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'balancita-vt02-'))
  const sourcePath = join(temporaryDirectory, 'frozen-market.sqlite')
  const accountPath = join(temporaryDirectory, 'paper-account.sqlite')
  let app: Awaited<ReturnType<typeof buildApp>> | undefined
  let vite: Awaited<ReturnType<typeof createViteServer>> | undefined
  let browser: Browser | undefined
  try {
    createRecordedSource(sourcePath)
    const sourceBytesBefore = createHash('sha256')
      .update(await readFile(sourcePath))
      .digest('hex')
    const vitePort = await availablePort()
    const origin = `http://127.0.0.1:${vitePort}`
    app = await buildApp({
      config: serverConfigFrom({
        FUTURES_MODE: 'replay',
        FUTURES_DB_PATH: accountPath,
        FUTURES_REPLAY_SOURCE_DB_PATH: sourcePath,
        GEMINI_SERVER_CORS_ORIGIN: origin,
      }),
    })
    const terminalApiRequests: string[] = []
    app.addHook('onRequest', (request, _reply, done) => {
      const path = new URL(request.url, 'http://localhost').pathname
      if (path === '/api/terminal/bootstrap' || path === '/api/terminal/export')
        terminalApiRequests.push(path)
      done()
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
    await mkdir(evidenceDirectory, { recursive: true })
    const pageErrors: string[] = []
    const apiRequests: string[] = []
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    })
    const page = await context.newPage()
    page.on('pageerror', (error) => pageErrors.push(error.message))
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/'))
        apiRequests.push(new URL(request.url()).pathname)
    })
    await page.goto(`${origin}/terminal`)
    await expect(page.getByRole('heading', { name: 'Terminal' })).toBeVisible()
    await expect(
      page
        .getByTestId('approved-trading-header')
        .getByText('REPLAY · OPERACIONES SIMULADAS'),
    ).toBeVisible()
    await expect(
      page.getByText(
        'Velas cerradas del origen registrado · operaciones simuladas.',
      ),
    ).toBeVisible()
    await expect(
      page.getByRole('link', {
        name: 'Descargar exportación verificada del run',
      }),
    ).toBeVisible()
    await expect(
      page.locator('[data-testid="approved-chart-renderer"]'),
    ).toHaveAttribute('data-candle-count', '60')
    const bootstrapsAfterRender = terminalApiRequests.filter(
      (path) => path === '/api/terminal/bootstrap',
    ).length
    await page.waitForTimeout(1200)
    expect(
      terminalApiRequests.filter((path) => path === '/api/terminal/bootstrap'),
    ).toHaveLength(bootstrapsAfterRender)
    const bootstrap = (await (
      await page.request.get(`${origin}/api/terminal/bootstrap`)
    ).json()) as ReplayBootstrap
    const sourceFileHash = bootstrap.source_manifest.source_file_hash
    expect(sourceFileHash).toBe(sourceBytesBefore)
    await page.screenshot({
      path: join(evidenceDirectory, 'connected-replay-desktop-1440x900.png'),
      fullPage: true,
    })

    const downloadPromise = page.waitForEvent('download')
    await page
      .getByRole('link', { name: 'Descargar exportación verificada del run' })
      .click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toBe('futures-replay-export.json')
    const downloadPath = await download.path()
    if (!downloadPath)
      throw new Error('Replay export download did not produce a file.')
    const exported = JSON.parse(
      await readFile(downloadPath, 'utf8'),
    ) as ReplayExport
    expect(exported).toMatchObject({
      verified: true,
      schema_version: 'futures-replay-export.v1',
    })
    expect(exported.comparison.equal).toBe(true)
    expect(exported.manifest_hash).toBe(exported.economic_export.manifest_hash)
    expect(exported.economic_export.inputs.length).toBeGreaterThan(0)
    expect(exported.batch_verification.inputs.length).toBeGreaterThan(0)
    expect(exported.run_id).toBe(bootstrap.active_run_id)

    await page.setViewportSize({ width: 390, height: 844 })
    const mobile = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
    }))
    expect(mobile.width).toBeLessThanOrEqual(390)
    await page.screenshot({
      path: join(evidenceDirectory, 'connected-replay-mobile-390x844.png'),
      fullPage: true,
    })
    expect(pageErrors).toEqual([])
    expect(
      apiRequests.filter((path) => path === '/api/terminal/bootstrap'),
    ).toHaveLength(2)
    expect(
      terminalApiRequests.filter((path) => path === '/api/terminal/bootstrap'),
    ).toHaveLength(bootstrapsAfterRender + 1)
    expect(
      terminalApiRequests.filter((path) => path === '/api/terminal/export'),
    ).toHaveLength(1)
    expect(
      createHash('sha256')
        .update(await readFile(sourcePath))
        .digest('hex'),
    ).toBe(sourceBytesBefore)
    await writeFile(
      join(evidenceDirectory, 'connected-replay-evidence.json'),
      `${JSON.stringify(
        {
          mode: 'replay',
          run_id: exported.run_id,
          source_hash: exported.source_hash,
          source_file_hash: sourceFileHash,
          manifest_hash: exported.manifest_hash,
          semantic_hash: exported.semantic_hash,
          verified: exported.verified,
          comparison: exported.comparison,
          exported_inputs: exported.economic_export.inputs.length,
          batch_inputs: exported.batch_verification.inputs.length,
          source_unchanged: true,
          api_requests: terminalApiRequests,
          page_errors: pageErrors,
        },
        null,
        2,
      )}\n`,
    )
    await context.close()
  } finally {
    await browser?.close()
    await vite?.close()
    await app?.close()
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
})
