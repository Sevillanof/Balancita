import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e/futures-terminal',
  testMatch: '**/*.pw.ts',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  timeout: 150_000,
  outputDir: './test-results/futures-terminal',
})
