import { defineConfig, devices } from '@playwright/test'

const baseSegments = (process.env.BASE_PATH ?? '/').split('/').filter(Boolean)
const basePath = baseSegments.length === 0 ? '/' : `/${baseSegments.join('/')}/`
const serverPort = process.env.PLAYWRIGHT_PORT ?? (basePath === '/' ? '4173' : '4174')
const serverOrigin = `http://127.0.0.1:${serverPort}`
const baseURL = new URL(basePath, serverOrigin).toString()

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `npm run build && npm run preview -- --host 127.0.0.1 --port ${serverPort}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  ],
})
