import { SAMPLES, chooseProject, expect, launchStudio, test, writeProject } from './studio.js';

// 悪意のある試作品の見本。それぞれの試みの結果を、自分の画面に書き出す。
function probeSource({ studioOrigin, otherBuildUrl }) {
  return `
const violations = [];
document.addEventListener('securitypolicyviolation', (event) => violations.push(event.blockedURI));
const results = document.createElement('ul');
document.getElementById('root').append(results);
function report(name, outcome) {
  const li = document.createElement('li');
  li.dataset.probe = name;
  li.textContent = outcome;
  results.append(li);
}
function attempt(name, fn) {
  try {
    const value = fn();
    if (value && typeof value.then === 'function') {
      value.then(() => report(name, 'allowed'), () => report(name, 'blocked'));
    } else {
      report(name, 'allowed');
    }
  } catch (error) {
    report(name, 'blocked');
  }
}
// 読み込みの失敗が CSP によるものだけを blocked とする。404 などで失敗しても blocked にしない
function load(name, element, url) {
  element.onload = () => report(name, 'allowed');
  element.onerror = () =>
    setTimeout(() => report(name, violations.includes(url) ? 'blocked' : 'failed without CSP violation'), 200);
  element.src = url;
  document.body.append(element);
}

const apiUrl = ${JSON.stringify(`${studioOrigin}/api/projects`)};
fetch(apiUrl).then(
  () => report('studio-api', 'allowed'),
  () => setTimeout(() => report('studio-api', violations.includes(apiUrl) ? 'blocked' : 'failed without CSP violation'), 200),
);
attempt('local-storage', () => window.localStorage.setItem('k', 'v'));
attempt('cookie', () => { document.cookie = 'k=v'; if (!document.cookie.includes('k=v')) throw new Error('no cookie'); });
attempt('parent-dom', () => window.parent.document.body.innerHTML);
attempt('top-navigation', () => { window.top.location.href = 'http://127.0.0.1:9/'; });
load('external-image', new Image(), ${JSON.stringify(`${studioOrigin}/studio.css`)});
load('other-project-script', document.createElement('script'), ${JSON.stringify(`${otherBuildUrl}app.js`)});

const leave = document.createElement('button');
leave.textContent = '外へ移動する';
leave.addEventListener('click', () => { window.location.href = 'http://127.0.0.1:9/?leak=1'; });
document.getElementById('root').append(leave);
`;
}

const PROBES = [
  'studio-api',
  'local-storage',
  'cookie',
  'parent-dom',
  'top-navigation',
  'external-image',
  'other-project-script',
];

test('試作品は Studio の API、親画面、ストレージ、外部、他のプロジェクトに届かない', async ({ page, home }) => {
  const studio = await launchStudio(home);
  try {
    const { projects } = await studio.api('/api/projects');
    const sample = projects.find((p) => p.id === SAMPLES.library.id);
    await writeProject(
      home,
      'probe',
      { 'main.js': probeSource({ studioOrigin: studio.origin, otherBuildUrl: sample.previewUrl }) },
      '悪意のある見本',
    );

    await page.goto(studio.url);
    // 起動の後に置いたプロジェクトは、一覧に出てから作り直すと開ける
    await chooseProject(page, /悪意のある見本/);
    await expect(page.locator('#build-status')).toContainText('まだビルドしていません');
    await page.getByRole('button', { name: '作り直す' }).click();
    await expect(page.locator('#build-status')).toContainText('ビルドに成功しました');

    const app = page.frameLocator('iframe[title="試作品"]');
    for (const name of PROBES) {
      await expect(app.locator(`[data-probe="${name}"]`), name).toHaveText('blocked');
    }
    // 親画面は乗っ取られていない
    expect(page.url()).toBe(`${studio.origin}/`);

    // 試作品が自分で移動すると、iframe を作り直して警告を出す
    const firstFrame = await page.locator('iframe[title="試作品"]').elementHandle();
    await app.getByRole('button', { name: '外へ移動する' }).click();
    await expect(page.locator('#events')).toContainText('試作品が別のページへ移動しようとしたので、最初から開き直しました');
    await expect(app.getByRole('button', { name: '外へ移動する' })).toBeVisible();
    expect(await firstFrame.evaluate((node) => node.isConnected)).toBe(false);
  } finally {
    await studio.stop();
  }
});

test('プレビューの URL を直接開いても sandbox が効き、他の版は返さない', async ({ page, request, home }) => {
  const studio = await launchStudio(home);
  try {
    const { projects } = await studio.api('/api/projects');
    const previewUrl = projects.find((p) => p.id === SAMPLES.library.id).previewUrl;

    const response = await request.get(previewUrl);
    expect(response.headers()['content-security-policy']).toContain('sandbox allow-scripts allow-forms');
    expect(response.headers()['content-security-policy']).toContain("connect-src 'none'");

    const unknown = previewUrl.replace(/[a-f0-9]{32}\/$/, `${'0'.repeat(32)}/`);
    expect((await request.get(unknown)).status()).toBe(404);
    expect((await request.get(`${previewUrl}..%2F..%2F..%2Fapp%2Fmain.jsx`)).status()).toBe(404);

    // CSP の frame-ancestors で、Studio 以外の画面には埋め込めない
    await page.goto(previewUrl);
    const opaque = await page.evaluate(() => window.origin);
    expect(opaque).toBe('null');
  } finally {
    await studio.stop();
  }
});
