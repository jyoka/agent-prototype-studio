import { defineConfig } from '@playwright/test';

// 実 API は呼ばない。各テストが Studio を一時フォルダーで起動し、終わったら止める。
// 例外は test/e2e/real-loop.spec.js で、STUDIO_REAL=1 のときだけ実モデルを呼ぶ。そのときは全体の上限を広げる
export default defineConfig({
  testDir: 'test/e2e',
  timeout: 30_000,
  globalTimeout: process.env.STUDIO_REAL === '1' ? 45 * 60_000 : 5 * 60_000,
  workers: 1,
  reporter: 'list',
  use: { browserName: 'chromium', headless: true },
});
