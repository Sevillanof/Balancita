import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { extractTokens } from './export-tokens.mjs'

const args = process.argv.slice(2)
assert.ok(
  args.length === 0 ||
    (args.length === 2 && args[0] === '--react18-runtime' && args[1]),
  'Usage: node scripts/design-system/verify.mjs [--react18-runtime DIRECTORY]',
)
const react18Directory = args[1]
const react18Version = '18.3.1'
// The official react-dom@18.3.1 UMD artifact exposes this build version.
const react18DOMVersion = '18.3.1-next-f1338f8080-20240426'
let hostRuntime
if (react18Directory) {
  const scripts = await Promise.all(
    ['react', 'react-dom'].map((name) =>
      readFile(join(react18Directory, `${name}.production.min.js`), 'utf8'),
    ),
  )
  const hashes = [
    'd949f1c3687aedadcedac85261865f29b17cd273997e7f6b2bfc53b2f9d4c4dd',
    '35f4f974f4b2bcd44da73963347f8952e341f83909e4498227d4e26b98f66f0d',
  ]
  for (const [index, source] of scripts.entries())
    assert.equal(
      createHash('sha256').update(source).digest('hex'),
      hashes[index],
      `Expected unmodified ${['react', 'react-dom'][index]}@18.3.1 production UMD`,
    )
  hostRuntime = `${scripts.join('\n;\n')}\n;
window.BalancitaRuntime = { React: window.React, ReactDOM: window.ReactDOM };`
}

const output = new URL('../../dist/design-system/', import.meta.url)
const text = (name) => readFile(new URL(name, output), 'utf8')
const js = await text('bundle.js')
const css = await text('bundle.css')
const tokens = JSON.parse(await text('tokens.json'))
const licenses = JSON.parse(await text('runtime-licenses.json'))
assert.ok(
  licenses.some(
    (item) => item.name === 'react' && item.text && item.identifier === 'MIT',
  ),
)
for (const font of ['inter', 'ibm-plex-mono']) {
  assert.match(await text(`${font}-LICENSE.txt`), /SIL OPEN FONT LICENSE/i)
}
assert.match(js, /^\/\*! @ds-bundle/)
assert.match(js, /createElement/)
assert.doesNotMatch(
  js,
  /jsx-runtime|react\.transitional\.element|react\.element/,
)
assert.doesNotMatch(
  css,
  /demo-terminal|connected-terminal__panel|source-switch-bar|red-500/,
)
assert.deepEqual(
  tokens,
  extractTokens(
    await readFile(
      new URL('../../src/shared/design-system/theme.css', import.meta.url),
      'utf8',
    ),
  ),
)

const browser = await chromium.launch({ channel: 'chrome' })
try {
  const errors = []
  const externalRequests = []
  const page = await browser.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await page.route(/^https?:/, (route) => {
    externalRequests.push(route.request().url())
    return route.abort('blockedbyclient')
  })
  let hostRuntimeLoads = 0
  if (hostRuntime) {
    await page.route(new URL('runtime.js', output).href, (route) => {
      hostRuntimeLoads++
      return route.fulfill({
        contentType: 'text/javascript',
        body: hostRuntime,
      })
    })
  }
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 })
    await page.goto(new URL('index.html', output).href)
    await page.locator('[data-component="AppShell"] section').waitFor()
    const versions = await page.evaluate(() => ({
      react: window.React.version,
      reactDOM: window.ReactDOM.version,
      sameReact: window.React === window.BalancitaRuntime.React,
      sameReactDOM: window.ReactDOM === window.BalancitaRuntime.ReactDOM,
    }))
    assert.ok(versions.sameReact && versions.sameReactDOM)
    if (hostRuntime) {
      assert.equal(versions.react, react18Version)
      assert.equal(versions.reactDOM, react18DOMVersion)
    }
    assert.equal(
      await page.locator('#runtime-version').textContent(),
      `React ${versions.react}`,
    )
    assert.equal(await page.locator('[data-component]').count(), 7)
    assert.equal(
      await page.locator('#palette .swatch').count(),
      tokens.filter((t) => t.type === 'color').length,
    )
    assert.equal(await page.locator('#token-rows tr').count(), tokens.length)
    await page.evaluate(() => document.fonts.ready)
    assert.ok(
      await page.evaluate(() =>
        [...document.fonts].some(
          (f) => f.family === 'Inter' && f.status === 'loaded',
        ),
      ),
      'Inter must load offline',
    )
    const dimensions = await page.evaluate(() => ({
      width: innerWidth,
      content: document.documentElement.scrollWidth,
    }))
    assert.equal(
      dimensions.content,
      dimensions.width,
      `Catalog overflow at ${width}px`,
    )
    const pill = page.locator('[data-component="StatusPill"]')
    for (const [tone, label] of Object.entries({
      nodata: 'Sin datos',
      ok: 'Correcto',
      warn: 'Advertencia',
      bad: 'Error',
    })) {
      await pill.getByRole('combobox').selectOption(tone)
      await pill.locator(`[data-tone="${tone}"]`).waitFor()
      assert.equal(await pill.locator('[data-tone]').textContent(), label)
      const color = await pill
        .locator('[data-tone]')
        .evaluate((el) => getComputedStyle(el).color)
      if (tone === 'nodata') assert.equal(color, 'rgb(148, 163, 184)')
    }
    const state = page.locator('[data-component="DataState"]')
    for (const kind of ['loading', 'error', 'empty', 'unavailable', 'nodata']) {
      await state.getByRole('combobox').selectOption(kind)
      const rendered = state.locator(`[data-kind="${kind}"]`)
      await rendered.waitFor()
      assert.equal(
        await rendered.getAttribute('role'),
        kind === 'error' ? 'alert' : 'status',
      )
    }
    const metric = page.locator('[data-component="Metric"]')
    for (const tone of ['neutral', 'up', 'down']) {
      await metric.getByRole('combobox').selectOption(tone)
      await metric.locator(`[data-tone="${tone}"]`).waitFor()
    }
    const provenance = page.locator('[data-component="DataProvenance"]')
    await provenance.getByRole('combobox').selectOption('Con datos')
    await provenance.getByText('demo-001', { exact: true }).waitFor()
    assert.match(await provenance.locator('dl').textContent(), /hace 4 s/)
    await provenance.getByRole('combobox').selectOption('Sin datos')
    await provenance.locator('[data-known="false"]').first().waitFor()
    assert.equal(await provenance.locator('[data-known="false"]').count(), 5)
    const bar = page.locator('[data-component="TopBar"]')
    await bar.getByRole('combobox').selectOption('Estrategias')
    await bar
      .locator('a[aria-current="page"]')
      .filter({ hasText: 'Estrategias' })
      .waitFor()
    await page.getByRole('searchbox').fill('color-long')
    assert.equal(await page.locator('#token-rows tr').count(), 1)
    await page.getByRole('searchbox').fill('not-a-token')
    assert.equal(await page.locator('#token-rows tr').count(), 0)
    await page.getByRole('searchbox').fill('')
    assert.equal(await page.locator('#token-rows tr').count(), tokens.length)
    console.log(
      `PASS ${width}px: React ${versions.react}, ReactDOM ${versions.reactDOM}, 7 previews, all variants, token search, no horizontal overflow`,
    )
  }
  assert.deepEqual(errors, [])
  assert.deepEqual(externalRequests, [])
  if (hostRuntime) assert.equal(hostRuntimeLoads, 3)
  console.log(
    `PASS ${tokens.length} source tokens, classic IIFE, no screen CSS or external requests`,
  )
  console.log(`Open ${fileURLToPath(new URL('index.html', output))}`)
} finally {
  await browser.close()
}
