import path from 'node:path';
import { ROOT, expect, launchStudio, test, writeProject } from './studio.js';

// 実モデルは呼ばない。Claude Code は偽の CLI(test/fixtures/fake-claude.js)に差し替える
const FAKE = path.join(ROOT, 'test', 'fixtures', 'fake-claude.js');

function fakeEnv(home) {
  return {
    STUDIO_ALLOW_CLAUDE_CODE: '1',
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
  await page.getByRole('button', { name: /サンプル: 架空の求人相談/ }).click();
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
    await page.getByRole('button', { name: 'リセット' }).click();
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

    await page.getByRole('radio', { name: 'Claude Code' }).check();
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Claude Code に切り替える' }).click();
    await expect(entries.first()).toContainText('接続の切り替え: モック → Claude Code(Studio の画面から)');
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
    await expect(ok).toContainText('費用の目安(CLI の報告): $0.0012');
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

    // 失敗: 利用の上限。理由と次にすること
    await type('[上限] もう一回');
    await expect(alert).toContainText('利用の上限');
    const limit = entries.first();
    await expect(limit).toContainText('失敗しました');
    await expect(limit).toContainText('理由: Claude Code の利用の上限に当たりました');
    await expect(limit).toContainText('次にすること: 時間をおいてから送り直すか、右の「接続を選ぶ」でモックに戻してください。会話はそのままです。');
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
    await page.locator('#ai-status').getByRole('button', { name: '応答を止める' }).click();
    await expect(alert).toHaveText('応答を止めました');
    await expect(running).toContainText('止めました');
    await expect(running).toContainText('次にすること: Studio の画面で止めました。試作品の欄に書いた文は残っているので、もう一度送れます。');
    await expect(message).toHaveValue('[遅い] よく考えて');

    // 失敗も止めたものも、会話は変えていない
    await expect(app.getByRole('region', { name: '会話' }).getByRole('listitem')).toHaveCount(5);
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
    await page.getByRole('button', { name: /要求を誤る試作品/ }).click();
    const app = page.frameLocator('iframe[title="試作品"]');
    const entries = page.locator('#ai-trace').getByRole('list', { name: 'AI の実行の記録' }).locator(':scope > li');

    await app.getByRole('button', { name: '海の町に直す' }).click();
    await expect(app.locator('output')).toHaveText('エラー: invalid');
    await expect(entries.first()).toContainText('状態の修正(試作品から)');
    await expect(entries.first()).toContainText('直そうとした値: place「海の町」');
    await expect(entries.first()).toContainText('理由: 行き先に「海の町」は使えません');
    await expect(entries.first()).toContainText('次にすること: 選べる値に直してください。試作品の画面が選べない値を送っているときは、「作る」欄で直す依頼をするか');

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
