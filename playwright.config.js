import { defineConfig } from '@playwright/test';

// 実 API は呼ばない。各テストが Studio を一時フォルダーで起動し、終わったら止める。
export default defineConfig({
  testDir: 'test/e2e',
  timeout: 30_000,
  globalTimeout: 5 * 60_000,
  workers: 1,
  reporter: 'list',
  use: { browserName: 'chromium', headless: true },
});
