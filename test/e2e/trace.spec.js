import path from 'node:path';
import { loadConfig } from '../../src/server/config.js';
import { startStudio } from '../../src/server/index.js';
import { ROOT, SAMPLES, chooseProject, chooseSample, expect, launchStudio, openDevDetails, switchToRealAi, test, writeProject } from './studio.js';

// 実モデルは呼ばない。Claude Code は偽の CLI(test/fixtures/fake-claude.js)に差し替える
// AI の実行の記録は、その他 → 開発者向けの詳細にある。引き出しは右に重なるが、左の試作品は開いたまま使える
const FAKE = path.join(ROOT, 'test', 'fixtures', 'fake-claude.js');

function fakeEnv(home) {
  return {
    STUDIO_CLAUDE_BIN: FAKE,
    FAKE_CLAUDE_LOG: path.join(home, 'fake-claude.jsonl'),
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_AUTH_TOKEN: undefined,
    ANTHROPIC_BASE_URL: undefined,
    CLAUDE_CODE_USE_BEDROCK: undefined,
    CLAUDE_CODE_USE_VERTEX: undefined,
    CLAUDE_CODE_USE_FOUNDRY: undefined,
  };
}

async function openJobConsult(page, studio) {
  await page.goto(studio.url);
  await chooseSample(page, SAMPLES.jobConsult);
  await openDevDetails(page);
  const app = page.frameLocator('iframe[title="試作品"]');
  const message = app.getByLabel('メッセージ');
  const type = async (text) => {
    await message.fill(text);
    await app.getByRole('button', { name: '送る' }).click();
  };
  const say = async (text) => {
    await type(text);
    await expect(message).toHaveValue('');
  };
  const trace = page.locator('#ai-trace');
  const entries = trace.getByRole('list', { name: 'AI の実行の記録' }).locator(':scope > li');
  return { app, message, type, say, trace, entries };
}

test('モックの実行の記録: 発言、返事、状態の変化、修正、リセットが出て、外へ送っていないことと伏せた個人のデータがわかる', async ({ page, home }) => {
  const studio = await launchStudio(home);
  try {
    const { app, say, trace, entries } = await openJobConsult(page, studio);

    await expect(trace).toContainText('今の接続: モック(AI モデルは呼んでいません)');
    await expect(trace).toContainText('AI が使えるツール: モックにはツールがありません');
    await expect(trace).toContainText('試作品から AI への操作: 会話を読む、発言を送る、状態を直す');
    await expect(trace).toContainText('まだ記録はありません');

    await say('カフェで働きたいです');
    const first = entries.first();
    await expect(first).toContainText('発言 → モック(AI モデルは呼んでいません)');
    await expect(first).toContainText('終わりました');
    await expect(first).toContainText('発言: カフェで働きたいです');
    await expect(first).toContainText('返事: 職種「カフェのホール」と理解しました。');
    await expect(first.getByRole('list', { name: '状態の変化' })).toHaveText('職種: 未定 → カフェのホール');
    // 開発向けの中身。モックは外へ送らず、費用も CLI の起動もない。ないものは出さない
    await first.getByText('AI に渡したもの、受け取ったもの(開発向け)').click();
    await expect(first).toContainText('送り先: どこにも送りません(Studio の中で応答します)');
    await expect(first).toContainText('使えるツール: モックにはツールがありません');
    await expect(first).toContainText('渡した会話: 1 件と、新しい発言');
    await expect(first).toContainText('受け取った updates: {"jobType":"カフェのホール"}');
    await expect(first).not.toContainText('費用');
    await expect(first).not.toContainText('起動の形');
    // harness の 3 段。何を聞くかは、接続ではなく決定(コード)が決めたと分かる
    await first.getByText('harness の段: 抽出 → 決定 → 言い方(開発向け)').click();
    await expect(first).toContainText('どう読んだか: 接続の抽出(extract)を呼びました');
    await expect(first).toContainText('検査で入れなかった値: なし');
    await expect(first).toContainText('決定: 段「hear」、ターン 1、聞く項目 雇用区分、言うこと なし、続ける');
    await expect(first).toContainText('理由: 段「hear」の遷移の条件をどれも満たしていないので、この段に留まる。段「hear」で未定の最初の項目「雇用区分」を聞く');
    await expect(first).toContainText('どう作ったか: 接続の言い方(phrase)を呼びました');
    // 返事の守ることの確かめ。モックの返事はいつも合う
    await expect(first).toContainText('結果: 合格');

    // 本人の修正
    await app.getByLabel('勤務地を直す').selectOption('もみじ台');
    await expect(entries.first()).toContainText('状態の修正(試作品から)');
    await expect(entries.first().getByRole('list', { name: '状態の変化' })).toHaveText('勤務地: 未定 → もみじ台');
    // 開いた中身は、記録が増えても開いたまま
    await expect(entries.nth(1)).toContainText('送り先: どこにも送りません');

    // 要らない個人のデータは、記録で伏せる(試作品の会話はそのまま)
    await say('連絡は taro@example.com か 090-1234-5678 にください');
    await expect(entries.first()).toContainText('発言: 連絡は [伏せた: メールアドレス] か [伏せた: 電話番号] にください');
    await expect(entries.first()).toContainText('状態の変化: なし');
    await expect(trace).not.toContainText('taro@example.com');
    await expect(app.getByRole('region', { name: '会話' })).toContainText('taro@example.com');

    // リセットしても記録は残り、リセットしたことが出る
    await page.getByRole('button', { name: '会話を最初から' }).click();
    await expect(entries.first()).toContainText('会話と状態を最初に戻しました(Studio の画面から)');
    await expect(entries.first()).toContainText('最初の状態: 職種「未定」、雇用区分「未定」、勤務地「未定」、時給の下限「未定」');
    await expect(entries).toHaveCount(4);

    await trace.getByRole('button', { name: '記録を消す' }).click();
    await expect(trace).toContainText('まだ記録はありません');
    expect(studio.output()).not.toContain('taro@example.com');
  } finally {
    await studio.stop();
  }
});

test('Claude Code(偽)の実行の記録: 渡した指示と本文、受け取った形と費用、失敗の理由と次にすること、伏せた鍵', async ({ page, home }) => {
  const studio = await launchStudio(home, { env: fakeEnv(home) });
  try {
    const { app, message, type, say, trace, entries } = await openJobConsult(page, studio);
    const conditions = app.getByRole('region', { name: '希望条件' }).locator('.value');
    const alert = app.getByRole('alert');

    // 同意の前は、本物の AI に切り替えられない(理由のコードつき)。記録にも切り替えは残らない
    const refused = await studio.post('/api/projects/sample-job-consult/ai/connection', { kind: 'claude-code' });
    expect(refused.status).toBe(403);
    expect(JSON.parse(refused.text).error.code).toBe('consent-required');
    // 同意のカードで「同意して使う」を押すと、本物の AI を使う同意になり、切り替わる
    await switchToRealAi(page);
    await expect(entries.first()).toContainText('接続の切り替え: モック → Claude Code(Studio の画面から)');
    expect((await studio.api('/api/real-ai')).consent.agreed).toBe(true);
    await expect(trace).toContainText('今の接続: Claude Code(実際の AI モデル)');
    await expect(trace).toContainText('AI が使えるツール: Claude Code にはツールを渡していません(--tools "")');

    // 正常: 渡したもの、受け取ったもの
    await say('書店の売り場で、正社員がいいです');
    const ok = entries.first();
    await expect(ok).toContainText('発言 → Claude Code(実際の AI モデル)');
    await expect(ok).toContainText('返事: 偽の Claude Code です。');
    await expect(ok.getByRole('list', { name: '状態の変化' }).getByRole('listitem')).toHaveText(['職種: 未定 → 書店の売り場', '雇用区分: 未定 → 正社員']);
    await ok.getByText('AI に渡したもの、受け取ったもの(開発向け)').click();
    await expect(ok).toContainText('送り先: Anthropic(Claude Code が送ります)');
    await expect(ok).toContainText('起動の形: fake-claude.js -p --restricted --safe-mode --tools');
    await expect(ok).toContainText(/--system-prompt=…\(\d+ 文字\)/);
    await expect(ok).toContainText('応答の形: 構造化出力(--json-schema)を読みました');
    // 抽出と言い方の 2 回の呼び出し。回数と待ち時間、費用の合計が出る
    await expect(ok).toContainText(/実際の AI モデルの呼び出し: 2 回\(抽出 1 回、言い方 1 回\)、待った時間の合計 [\d.]+ 秒/);
    await expect(ok.getByRole('list', { name: '呼び出しの 1 回ずつ' }).getByRole('listitem')).toHaveText([/^抽出\(1 回目\)/, /^言い方\(1 回目\)/]);
    await expect(ok).toContainText('費用の目安(CLI の報告): $0.0024');
    await ok.getByText('指示(--system-prompt)の全文').click();
    await expect(ok.locator('pre').first()).toContainText('しおかぜ求人相談');
    await ok.getByText('本文(標準入力)の全文').click();
    await expect(ok.locator('pre').nth(1)).toContainText('<新しい発言>\n書店の売り場で、正社員がいいです\n</新しい発言>');

    // 決まりに合わない値は、状態に入れなかったことが出る
    await say('[範囲外]');
    await expect(entries.first()).toContainText('状態の変化: なし');
    await expect(entries.first()).toContainText('状態に入れなかった値: 職種「ない選択肢」(項目の決まりに合わない値)');
    await expect(entries.first()).toContainText('unknownField「x」(app/ai.json にない項目)');
    await expect(conditions).toHaveText(['書店の売り場', '正社員', '未定', '未定']);

    // 守ることに合わない返事は、合わなかった決まりとやり直しが出る
    await say('[一度数を作る] 場所はまだ決めていません');
    const retried = entries.first();
    await retried.getByText('harness の段: 抽出 → 決定 → 言い方(開発向け)').click();
    await expect(retried).toContainText('結果: やり直して合格。合わなかった決まり: 数字を作らない(noNewNumbers)');
    await expect(retried).toContainText('1 回目の返事: 偽の Claude Code です。');
    await expect(retried).toContainText('数字を作らない: 「987」は、状態、利用者の発言、問いの原文、架空のデータのどれにも出てこない数');
    await expect(retried).toContainText('2 回目の返事: 偽の Claude Code です。');
    await expect(retried).toContainText(/実際の AI モデルの呼び出し: 3 回\(抽出 1 回、言い方 2 回\)/);

    // 失敗: 利用の上限。理由と次にすること
    await type('[上限] もう一回');
    await expect(alert).toContainText('利用の上限');
    const limit = entries.first();
    await expect(limit).toContainText('失敗しました');
    await expect(limit).toContainText('理由: Claude Code の利用の上限に当たりました');
    await expect(limit).toContainText('次にすること: 時間をおいてから送り直すか、「試す」の上の「AI」でモックに戻してください。会話はそのままです。');
    await expect(page.locator('#events')).toContainText('次にすること: 時間をおいてから送り直すか');

    // 失敗: CLI のエラーに鍵らしい文字列があっても、画面にも記録にも出さない
    await type('[鍵を出す]');
    await expect(alert).toContainText('Claude Code にログインできていません');
    await expect(entries.first()).toContainText('理由: Claude Code にログインできていません(Invalid API key: [伏せた: API キーらしい文字列]');
    await expect(entries.first()).toContainText('次にすること: ターミナルで claude を起動し、ログインしてから');
    await expect(alert).not.toContainText('FAKEKEY');
    expect(await page.content()).not.toContain('FAKEKEY');

    // 待つ間は「待っています」と渡したものが見え、止めると理由と次にすることが出る
    await type('[遅い] よく考えて');
    const running = entries.first();
    await expect(running).toContainText('応答を待っています…');
    await expect(running).toContainText('発言: [遅い] よく考えて');
    // 「応答を止める」は、開発者向けの詳細ではなく、試す欄の上に出る
    await page.locator('#ai-waiting').getByRole('button', { name: '応答を止める' }).click();
    await expect(alert).toHaveText('応答を止めました');
    await expect(running).toContainText('止めました');
    await expect(running).toContainText('次にすること: Studio の画面で止めました。試作品の欄に書いた文は残っているので、もう一度送れます。');
    await expect(message).toHaveValue('[遅い] よく考えて');

    // 失敗も止めたものも、会話は変えていない
    await expect(app.getByRole('region', { name: '会話' }).getByRole('listitem')).toHaveCount(7);
    expect(studio.output()).not.toContain('FAKEKEY');
    expect(studio.output()).not.toContain('書店の売り場で、正社員がいいです');
  } finally {
    await studio.stop();
  }
});

// 試作品のコードの誤りで AI への要求が断られたときも、理由と次にすることを出す
const BUGGY_AI = {
  name: '旅の相談(架空)',
  fields: [{ key: 'place', label: '行き先', options: [{ value: '湖の町', keywords: ['湖'] }] }],
};
const BUGGY_MAIN = `
const root = document.getElementById('root');
const out = document.createElement('output');
const wrong = document.createElement('button');
wrong.textContent = '海の町に直す';
const empty = document.createElement('button');
empty.textContent = '空で送る';
root.append(wrong, empty, out);
const fail = (error) => (out.textContent = 'エラー: ' + error.code);
wrong.addEventListener('click', () => window.studio.ai.correct({ place: '海の町' }).catch(fail));
empty.addEventListener('click', () => window.studio.ai.send('').catch(fail));
`;

test('試作品のコードが決まりに合わない要求を送ったら、記録に理由と直し方を出す', async ({ page, home }) => {
  await writeProject(home, 'buggy-ai', { 'main.js': BUGGY_MAIN, 'ai.json': JSON.stringify(BUGGY_AI) }, '要求を誤る試作品');
  const studio = await launchStudio(home);
  try {
    await page.goto(studio.url);
    await chooseProject(page, /要求を誤る試作品/);
    await openDevDetails(page);
    const app = page.frameLocator('iframe[title="試作品"]');
    const entries = page.locator('#ai-trace').getByRole('list', { name: 'AI の実行の記録' }).locator(':scope > li');

    await app.getByRole('button', { name: '海の町に直す' }).click();
    await expect(app.locator('output')).toHaveText('エラー: invalid');
    await expect(entries.first()).toContainText('状態の修正(試作品から)');
    await expect(entries.first()).toContainText('直そうとした値: place「海の町」');
    await expect(entries.first()).toContainText('理由: 行き先に「海の町」は使えません');
    await expect(entries.first()).toContainText('次にすること: 選べる値に直してください。試作品の画面が選べない値を送っているときは、「言葉で直す」欄で直す依頼をするか');

    await app.getByRole('button', { name: '空で送る' }).click();
    await expect(entries.first()).toContainText('発言: (空)');
    await expect(entries.first()).toContainText('理由: 話す内容を書いてください');
    await expect(entries.first()).toContainText('次にすること: 空でない、500 文字までの文を送ってください。');
    // 接続に渡す前に断ったので、渡したものは出さない
    await expect(entries.first()).not.toContainText('AI に渡したもの');
  } finally {
    await studio.stop();
  }
});

test('試す画面で話している途中に観察を回しても、利用者の会話は残る。観察の会話は記録に「観察から」の印で出る', async ({ page, home }) => {
  // 観察はまだ画面から回せない(CLI もない)ので、同じプロセスで起動した Studio から回す
  const config = loadConfig({ STUDIO_HOME: home, STUDIO_PORT: '0', STUDIO_PREVIEW_PORT: '0', STUDIO_NO_OPEN: '1', STUDIO_AGENT: 'fake' });
  const studio = await startStudio(config, { env: {} });
  try {
    const { app, say, entries } = await openJobConsult(page, studio);
    await say('カフェで働きたいです');
    const chat = app.getByRole('region', { name: '会話' });
    await expect(chat).toContainText('カフェで働きたいです');

    // 見本のシナリオ(app/scenarios/)は回さず、基本のシナリオ(起動、あいさつ)だけを回す
    const report = await studio.observe('sample-job-consult', { aiConnection: 'mock', viewports: [], scenarios: [] });
    expect(report.verdict).toBe('passed');
    expect(report.ai.map((entry) => entry.type)).toEqual(['open']);

    // 試す画面の会話は続けられる。観察のあいさつや発言は入らない
    await say('しおかぜ町でお願いします');
    await expect(chat).toContainText('カフェで働きたいです');
    await expect(app.getByRole('region', { name: '希望条件' })).toContainText('カフェのホール');
    const view = studio.aiSessions.view('sample-job-consult');
    expect(view.messages.map((m) => m.role)).toEqual(['assistant', 'user', 'assistant', 'user', 'assistant']);
    expect(view.state).toMatchObject({ jobType: 'カフェのホール', area: 'しおかぜ町' });

    // 記録の並びはそのまま(新しい方から)。観察の会話の始まりにだけ印が付く
    await expect(entries).toHaveCount(3);
    await expect(entries.nth(0)).toContainText('発言: しおかぜ町でお願いします');
    await expect(entries.nth(0)).not.toContainText('観察から');
    await expect(entries.nth(1)).toContainText('観察の会話を始めました → モック(AI モデルは呼んでいません)');
    await expect(entries.nth(1)).toContainText('観察から');
    await expect(entries.nth(1)).toContainText('あいさつ: こんにちは。しおかぜ求人相談の案内役です');
    await expect(entries.nth(2)).toContainText('発言: カフェで働きたいです');
    await expect(entries.nth(2)).not.toContainText('観察から');

    // 開き直しても、利用者の会話はサーバーに残っている
    await page.reload();
    await chooseSample(page, SAMPLES.jobConsult);
    await expect(page.frameLocator('iframe[title="試作品"]').getByRole('region', { name: '会話' })).toContainText('しおかぜ町でお願いします');
  } finally {
    await studio.close();
  }
});
