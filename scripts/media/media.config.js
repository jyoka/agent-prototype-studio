import os from 'node:os';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

// npm run media の設定(CONTRIBUTING.md の「画像と動く画像を撮り直す」)。E2E(playwright.config.js)とは別に回す。
// 実 API は呼ばない。Studio は偽接続(STUDIO_AGENT=fake)で、試作品の中の AI はモック。費用はかからない。
// 撮った画像は assets/media/ に置く。Playwright の途中の物は一時フォルダーに置き、リポジトリに残さない
export default defineConfig({
  testDir: '.',
  testMatch: 'media.spec.js',
  outputDir: path.join(os.tmpdir(), 'prototype-studio-media-results'),
  timeout: 120_000,
  globalTimeout: 6 * 60_000,
  workers: 1,
  reporter: 'list',
  use: { browserName: 'chromium', headless: true },
});
