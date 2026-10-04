import { defineConfig } from '@playwright/test'

const baseURL = 'http://127.0.0.1:5174'
const chromiumExecutablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.pw.ts',
  fullyParallel: false,
  reporter: 'list',
  outputDir: './test-results',
  use: {
    baseURL,
    browserName: 'chromium',
    timezoneId: 'UTC',
    ...(chromiumExecutablePath
      ? { launchOptions: { executablePath: chromiumExecutablePath } }
      : {}),
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'desktop-1440x900',
      use: { viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'desktop-1280x800',
      use: { viewport: { width: 1280, height: 800 } },
    },
    { name: 'mobile-390x844', use: { viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    command: 'pnpm exec vite --host 127.0.0.1 --port 5174 --strictPort',
    url: baseURL,
    reuseExistingServer: false,
    timeout: 30_000,
  },
})
