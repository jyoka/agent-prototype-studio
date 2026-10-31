import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, chooseProject, expect, launchStudio, openDevDetails, test, writeProject } from './studio.js';

const FIXTURE_APP = path.join(ROOT, 'test', 'fixtures', 'default-material', 'app');

test('既定の素材の部品を使った見本が、外への通信なしで描ける', async ({ page, request, home }) => {
  const studio = await launchStudio(home);
  try {
    const files = Object.fromEntries(await Promise.all(
      (await fs.readdir(FIXTURE_APP)).map(async (name) => [name, await fs.readFile(path.join(FIXTURE_APP, name), 'utf8')]),
    ));
    await writeProject(home, 'material', files, '既定の素材の見本');

    // 開いてからの要求を全部集める。試作品の iframe の要求は、自分の版の URL だけのはず
    const requests = [];
    page.on('request', (req) => requests.push(req));
    const failures = [];
    page.on('requestfailed', (req) => failures.push(req.url()));
    const consoleErrors = [];
    // 試作品から出たものだけを見る。ビルド前の Studio の API の 404 は試作品のものではない
    page.on('console', (message) => {
      if (message.type() === 'error' && message.location().url.includes('/p/material/')) consoleErrors.push(message.text());
    });

    await page.goto(studio.url);
    await chooseProject(page, /既定の素材の見本/);
    await openDevDetails(page);
    await page.getByRole('button', { name: 'ファイルから作り直す' }).click();
    await expect(page.locator('#build-status')).toContainText('ビルドに成功しました');

    const app = page.frameLocator('iframe[title="試作品"]');
    await expect(app.getByRole('heading', { name: '図書室の予約(架空)' })).toBeVisible();

    // 部品に既定の素材の見た目が付く。ブラウザの既定の見た目のままなら CSS が読めていない
    const reserve = app.getByRole('button', { name: '予約する' });
    await expect(reserve).toHaveClass(/rt-Button/);
    const { background, accent } = await reserve.evaluate((node) => {
      const probe = document.createElement('span');
      probe.style.background = 'var(--accent-9)';
      node.parentElement.append(probe);
      const colors = { background: getComputedStyle(node).backgroundColor, accent: getComputedStyle(probe).backgroundColor };
      probe.remove();
      return colors;
    });
    expect(accent).not.toBe('rgba(0, 0, 0, 0)');
    expect(background).toBe(accent);
    await expect(app.getByTestId('card')).toHaveClass(/rt-Card/);
    await expect(app.getByTestId('badge')).toHaveClass(/rt-Badge/);

    // アイコンは束の中の SVG
    await expect(app.locator('svg[data-testid="icon"]')).toBeVisible();
    await expect(app.locator('svg.lucide-calendar-check')).toBeVisible();
    await expect(app.locator('img')).toHaveCount(0);

    // Radix Colors の値が届く(blue.blue9 は #0090ff)。CSS の束は単体のテストで確かめる
    await expect(app.getByTestId('color-step')).toHaveCSS('background-color', 'rgb(0, 144, 255)');

    // 字は OS の字。字のファイルを読まず、並びの中に OS の字がある
    const fonts = await app.locator('.radix-themes').first().evaluate((node) => getComputedStyle(node).fontFamily);
    expect(fonts).toContain('system-ui');

    // ラベルで入力に届き、枠の部品が sandbox の中で開いて閉じる
    await app.getByRole('textbox', { name: '予約する人の名前' }).fill('架空 花子');
    await reserve.click();
    const dialog = app.getByRole('dialog', { name: '予約を確かめる' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('架空 花子 さんの予約です。');
    await dialog.getByRole('button', { name: '閉じる' }).click();
    await expect(dialog).toBeHidden();

    // 隔離の E2E と同じ確かめ方: CSP に止められたものがない
    await expect(app.getByTestId('violations')).toHaveText('');

    // 外への通信がない: iframe が読んだのは自分の版のファイルだけ
    const src = await page.locator('iframe[title="試作品"]').getAttribute('src');
    const base = new URL('./', new URL(src, studio.url)).href;
    const frameRequests = requests.filter((req) => req.frame() === page.frames().find((frame) => frame.url().startsWith(base)));
    const loaded = frameRequests.map((req) => req.url()).filter((url) => !url.startsWith('data:') && !url.startsWith('blob:'));
    expect(loaded.length).toBeGreaterThan(0);
    expect(loaded.filter((url) => !url.startsWith(base))).toEqual([]);
    expect(new Set(loaded.map((url) => url.slice(base.length)))).toEqual(new Set(['', 'runtime.js', 'app.js', 'app.css']));
    // ページ全体でも、Studio と試作品の loopback の外へ出ていない
    const outside = requests.map((req) => new URL(req.url())).filter((url) => /^https?:$/.test(url.protocol) && !['127.0.0.1', 'localhost'].includes(url.hostname));
    expect(outside.map((url) => url.href)).toEqual([]);
    expect(failures).toEqual([]);
    expect(consoleErrors).toEqual([]);

    // 配信の CSP は弱めていない
    const csp = (await request.get(base)).headers()['content-security-policy'];
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain('sandbox allow-scripts allow-forms');
  } finally {
    await studio.stop();
  }
});
