import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

const installedChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = process.env.STEWARD_TEST_CHROME ?? (existsSync(installedChrome) ? installedChrome : undefined);

export default defineConfig({
  testDir: './e2e',
  outputDir: '../../.pi/tmp/steward-web-e2e/results',
  workers: 1,
  reporter: 'list',
  use: { browserName: 'chromium', launchOptions: { executablePath }, locale: 'zh-CN', colorScheme: 'light',
    contextOptions: { reducedMotion: 'reduce' } },
});
