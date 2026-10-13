import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

/** The documented examples the backend tests generate from its own code. */
const example = (path: string) =>
  JSON.parse(readFileSync(join('docs/mission-control', path), 'utf8'))

async function serve(
  page: Page,
  health: unknown,
  activity: Record<string, unknown>,
) {
  // Everything else of the live gateway is down, as it would be without it.
  await page.route('**/api-live/**', (route) =>
    route.fulfill({ status: 503, json: {} }),
  )
  await page.route('**/api-live/api/observability/health', (route) =>
    route.fulfill({ json: health }),
  )
  await page.route('**/api-live/api/observability/activity**', (route) => {
    const window = new URL(route.request().url()).searchParams.get('window')
    route.fulfill({ json: { ...activity, window } })
  })
}

async function shot(page: Page, name: string) {
  mkdirSync('playwright-artifacts/observability', { recursive: true })
  await page.screenshot({
    path: join(
      'playwright-artifacts/observability',
      `${test.info().project.name}-${name}.png`,
    ),
    fullPage: true,
  })
}

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
}

test('observabilidad shows the six health components and the activity with their limits', async ({
  page,
}) => {
  await serve(
    page,
    example('b1/ejemplo-degradado.json'),
    example('b2/ejemplo-con-actividad.json'),
  )
  await page.goto('/observabilidad')
  await expect(
    page.getByRole('heading', { name: 'Observabilidad', level: 1 }),
  ).toBeVisible()
  await expect(page.getByTestId('health-risk')).toContainText('Sin datos')
  await expect(page.getByTestId('activity-experiments')).toBeVisible()
  await expect(page.getByTestId('activity-limitations')).toContainText(
    'no posiciones actuales verificadas',
  )
  // Open the first component's evidence so the capture shows what backs it.
  await page.getByTestId('health-data').locator('summary').click()
  await shot(page, 'degradado-con-actividad')
  await noHorizontalScroll(page)
})

test('observabilidad with no readable source shows «Sin datos», never healthy', async ({
  page,
}) => {
  await serve(
    page,
    example('b1/ejemplo-sin-datos.json'),
    example('b2/ejemplo-sin-datos.json'),
  )
  await page.goto('/observabilidad')
  await expect(page.getByTestId('health-overall')).toBeVisible()
  await expect(
    page.getByRole('region', { name: 'Actividad verificable' }),
  ).toContainText('No disponible')
  await expect(page.locator('.mc-pill[data-tone="ok"]')).toHaveCount(0)
  await shot(page, 'sin-datos')
  await noHorizontalScroll(page)
})
