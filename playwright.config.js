import { defineConfig } from '@playwright/test';

// 実 API は呼ばない。各テストが Studio を一時フォルダーで起動し、終わったら止める。
// 例外は test/e2e/real-loop.spec.js で、STUDIO_REAL=1 のときだけ実モデルを呼ぶ。そのときは全体の上限を広げる
// 全体の上限は 7 分。全体の実測はおよそ 3 分半(2026-10、70 件、workers: 1)で、その 2 倍ほどにした。
// 遅い機械や混んだ機械でも、上限で落ちて不具合と取り違えないため。件数が増えて実測が延びたら、合わせて広げる
export default defineConfig({
  testDir: 'test/e2e',
  timeout: 30_000,
  globalTimeout: process.env.STUDIO_REAL === '1' ? 45 * 60_000 : 7 * 60_000,
  workers: 1,
  reporter: 'list',
  use: { browserName: 'chromium', headless: true },
});
