import { defineConfig, devices } from '@playwright/test';
import { randomBytes } from 'node:crypto';
process.env.E2E_ADMIN_PASSWORD ||= randomBytes(18).toString('base64url');
process.env.E2E_DATA_DIR ||= `.data/e2e-${Date.now()}`;
const built = process.env.E2E_BUILT === 'true';
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  expect: { timeout: 10000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:5174',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: built ? 'node dist-server/index.js' : 'npx tsx server/index.ts',
      url: 'http://127.0.0.1:3002/api/v1/health/ready',
      reuseExistingServer: false,
      timeout: 120000,
      env: {
        NODE_ENV: 'test',
        DATABASE_URL: process.env.E2E_DATABASE_URL || '',
        STORAGE_DRIVER: 'local',
        SMTP_URL: '',
        SEED_SAMPLE_SOURCE: process.env.E2E_SAMPLE_SOURCE || 'legacy-components',
        JWT_SECRET: randomBytes(48).toString('hex'),
        COOKIE_SECRET: randomBytes(48).toString('hex'),
        PORT: '3002',
        APP_ORIGIN: 'http://127.0.0.1:5174',
        DATA_DIR: process.env.E2E_DATA_DIR,
        ADMIN_EMAIL: 'admin@e2e.local',
        ADMIN_PASSWORD: process.env.E2E_ADMIN_PASSWORD,
        LOG_LEVEL: 'warn',
      },
    },
    {
      command: built
        ? 'npx vite preview --host 127.0.0.1 --port 5174'
        : 'npx vite --host 127.0.0.1',
      url: 'http://127.0.0.1:5174',
      reuseExistingServer: false,
      timeout: 120000,
      env: { PORT: '3002', VITE_PORT: '5174' },
    },
  ],
});
