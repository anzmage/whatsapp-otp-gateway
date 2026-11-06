import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
const chrome = process.env.CHROME_PATH || (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined);
export default defineConfig({
  testDir: './e2e', workers: 1, timeout: 60_000,
  use: { headless: true, launchOptions: chrome ? { executablePath: chrome } : {}, trace: 'off' },
  reporter: 'list',
});
