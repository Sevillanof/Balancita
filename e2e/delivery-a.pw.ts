import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

const demoOrigin = 'http://127.0.0.1:5174'

async function monitorPage(page: import('@playwright/test').Page) {
  const errors: string[] = []
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== demoOrigin || url.pathname.startsWith('/api/')) {
      errors.push(
        `Unexpected request: ${route.request().method()} ${route.request().url()}`,
      )
      await route.abort()
      return
    }
    await route.continue()
  })
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.origin !== demoOrigin || url.pathname.startsWith('/api/'))
      errors.push(`Unexpected request: ${request.method()} ${request.url()}`)
  })
  return errors
}

async function savePage(page: import('@playwright/test').Page, name: string) {
  const directory = join('playwright-artifacts', 'delivery-a')
  mkdirSync(directory, { recursive: true })
  await page.screenshot({
    path: join(directory, `${test.info().project.name}-${name}.png`),
    fullPage: true,
  })
}

async function expectDesignFontsLoaded(page: import('@playwright/test').Page) {
  const results = await page.evaluate(async () => {
    const fonts = [
      ['DM Sans', 400],
      ['DM Sans', 500],
      ['DM Sans', 600],
      ['DM Sans', 700],
      ['IBM Plex Mono', 400],
      ['IBM Plex Mono', 500],
      ['IBM Plex Mono', 600],
      ['IBM Plex Mono', 700],
    ] as const
    const loadedFaces = await Promise.all(
      fonts.map(async ([family, weight]) => {
        const loaded = await document.fonts.load(
          `${weight} 14px "${family}"`,
          'Balancita BTC/EUR 123456789 €',
        )
        return { family, weight, loaded: loaded.length > 0 }
      }),
    )
    const shell = document.querySelector('.demo-shell')
    const eyebrow = document.querySelector('.demo-shell__eyebrow')
    if (!shell || !eyebrow)
      throw new Error('Demo font targets were not rendered.')
    return {
      loadedFaces,
      sansFamily: getComputedStyle(shell).fontFamily,
      monoFamily: getComputedStyle(eyebrow).fontFamily,
    }
  })
  expect(results.loadedFaces.every((font) => font.loaded)).toBe(true)
  expect(results.sansFamily).toContain('DM Sans')
  expect(results.monoFamily).toContain('IBM Plex Mono')
}

test('terminal chart renders useful simulated data and preserves the existing route boundary', async ({
  page,
}) => {
  const errors = await monitorPage(page)
  await page.goto('/demo')
  await expect
    .poll(() =>
      page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
    )
    .toBe('UTC')
  await expectDesignFontsLoaded(page)
  await expect(page.getByRole('heading', { name: 'Terminal' })).toBeVisible()
  await expect(page.getByText('DEMO · DATOS SIMULADOS')).toBeVisible()
  await expect(page.getByText('Entrada larga').first()).toBeVisible()
  await expect(page.getByText('Entrada corta').first()).toBeVisible()
  await expect(
    page.getByRole('link', { name: 'Aplicación actual' }),
  ).toBeVisible()
  await expect(
    page.locator('.demo-terminal__chart canvas').first(),
  ).toBeVisible()
  await expect
    .poll(() => page.locator('.demo-terminal__chart canvas').count())
    .toBeGreaterThan(0)
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true)
  if (test.info().project.name === 'mobile-390x844')
    await expect
      .poll(() =>
        page
          .locator('.demo-terminal__table-scroll')
          .first()
          .evaluate((element) => element.scrollWidth > element.clientWidth),
      )
      .toBe(true)
  await savePage(page, 'terminal')
  expect(errors).toEqual([])

  await page.goto('/')
  await expect(page.locator('main.app')).toBeVisible()
  await expect(
    page.getByRole('link', { name: 'Aplicación actual' }),
  ).toHaveCount(0)
  await expect(page.getByText('DEMO · DATOS SIMULADOS')).toHaveCount(0)
})

test('terminal interval, shared filters, event selection, chooser, and clock controls work', async ({
  page,
}) => {
  const errors = await monitorPage(page)
  await page.goto('/demo')
  const eventList = page.locator('aside[aria-label="Decisiones del motor"]')
  const initialEvents = await eventList.getByRole('button').count()
  expect(initialEvents).toBeGreaterThan(0)

  for (const interval of ['1m', '5m', '15m', '1h']) {
    await page.getByRole('button', { name: interval, exact: true }).click()
    await expect(
      page.getByRole('button', { name: interval, exact: true }),
    ).toHaveAttribute('aria-pressed', 'true')
    await expect(
      page.locator('.demo-terminal__chart canvas').first(),
    ).toBeVisible()
    await expect(eventList.getByRole('button')).toHaveCount(initialEvents)
  }

  const firstEvent = eventList.getByRole('button').first()
  const eventText = await firstEvent.innerText()
  await firstEvent.focus()
  await page.keyboard.press('Enter')
  await expect(firstEvent).toHaveAttribute('aria-pressed', 'true')
  expect(
    await firstEvent.evaluate((element) => element.matches(':focus-visible')),
  ).toBe(true)
  await expect(page.locator('.demo-terminal__selection')).toContainText(
    eventText.split('\n').at(-2) ?? '',
  )

  await page.mouse.move(0, 0)
  const chart = page.locator('.demo-terminal__chart')
  const chartBeforeFilter = await chart.screenshot()
  await page.getByLabel('Entradas').uncheck()
  await expect(
    eventList.getByRole('button', { name: /Entrada larga|Entrada corta/ }),
  ).toHaveCount(0)
  const chartAfterFilter = await chart.screenshot()
  expect(chartBeforeFilter.equals(chartAfterFilter)).toBe(false)
  await page.getByLabel('Entradas').check()
  await expect(eventList.getByRole('button')).toHaveCount(initialEvents)

  await page.getByRole('button', { name: '1h', exact: true }).click()
  const chartCanvas = page.locator('.demo-terminal__chart canvas').first()
  const bounds = await chartCanvas.boundingBox()
  if (!bounds)
    throw new Error('The market chart canvas has no browser layout box.')
  await page.mouse.click(bounds.x + 14, bounds.y + 165)
  const chooser = page.getByRole('dialog', { name: 'Decisiones en esta vela' })
  await expect(chooser).toBeVisible()
  await expect
    .poll(() => chooser.getByRole('button').count())
    .toBeGreaterThan(1)
  const choice = chooser.getByRole('button').first()
  const choiceReason =
    (await choice.innerText()).split('·').at(-1)?.trim() ?? ''
  await choice.click()
  await expect(chooser).toHaveCount(0)
  await expect(page.locator('.demo-terminal__selection')).toContainText(
    choiceReason,
  )
  await expect(
    eventList.locator('.demo-terminal__event.is-selected'),
  ).toContainText(choiceReason)
  await expect(
    eventList.locator('.demo-terminal__event.is-selected'),
  ).toHaveAttribute('aria-pressed', 'true')

  const initialQuote = await page
    .locator('.demo-terminal__quote strong')
    .innerText()
  await page.getByRole('button', { name: 'Reanudar simulación' }).click()
  await expect(page.getByLabel('Simulación en marcha')).toBeVisible()
  await expect
    .poll(() => eventList.getByRole('button').count(), {
      timeout: 24_000,
    })
    .toBe(initialEvents + 1)
  await expect(page.locator('.demo-terminal__quote strong')).not.toHaveText(
    initialQuote,
  )
  await page.getByRole('button', { name: 'Pausar simulación' }).click()
  const pausedQuote = await page
    .locator('.demo-terminal__quote strong')
    .innerText()
  await page.waitForTimeout(2_700)
  await expect(page.locator('.demo-terminal__quote strong')).toHaveText(
    pausedQuote,
  )
  await expect(eventList.getByRole('button')).toHaveCount(initialEvents + 1)
  await page.getByRole('button', { name: 'Reiniciar' }).click()
  await expect(page.locator('.demo-terminal__quote strong')).toHaveText(
    initialQuote,
  )
  await expect(eventList.getByRole('button')).toHaveCount(initialEvents)
  expect(errors).toEqual([])
})

test('historical demo submits a parameter snapshot and renders an illustrative chart', async ({
  page,
}) => {
  const errors = await monitorPage(page)
  await page.goto('/demo/historicas')
  await expectDesignFontsLoaded(page)
  await expect(
    page.getByRole('heading', { name: 'Pruebas históricas' }),
  ).toBeVisible()
  await expect(page.getByText('Sin resultados todavía')).toBeVisible()
  await expect(
    page.getByText('SIMULACIÓN DE EJEMPLO · NO VALIDADA'),
  ).toBeVisible()
  await savePage(page, 'historical-empty')

  await page.getByLabel('Capital inicial (EUR)').fill('12345')
  await page.getByLabel('Intervalo').selectOption('1h')
  await page.getByRole('button', { name: /ejecutar simulación/i }).click()
  await expect(page.getByText(/Capital inicial: 12\.345,00 EUR/)).toBeVisible()
  await expect(
    page.getByRole('img', { name: 'Curva de capital ilustrativa' }),
  ).toBeVisible()
  await expect(page.locator('.demo-history__trades table')).toBeVisible()
  await page.getByLabel('Capital inicial (EUR)').fill('20000')
  await expect(page.getByText(/Capital inicial: 12\.345,00 EUR/)).toBeVisible()
  await expect(page.locator('.demo-history__table-scroll')).toBeVisible()
  await savePage(page, 'historical-results')
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true)
  expect(errors).toEqual([])
})
