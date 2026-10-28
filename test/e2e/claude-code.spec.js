import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, expect, launchStudio, test } from './studio.js';

// 実モデルは呼ばない。Claude Code は偽の CLI(test/fixtures/fake-claude.js)に差し替える
const FAKE = path.join(ROOT, 'test', 'fixtures', 'fake-claude.js');
const AFTER_JOB = '職種「カフェのホール」と理解しました。働き方の希望はありますか?';

async function readCalls(file) {
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function fakeEnv(home, extra = {}) {
  return {
    STUDIO_ALLOW_CLAUDE_CODE: '1',
    STUDIO_CLAUDE_BIN: FAKE,
    FAKE_CLAUDE_LOG: path.join(home, 'fake-claude.jsonl'),
    // 手元の設定に左右されないよう、送り先と課金を変える環境変数を消す
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_AUTH_TOKEN: undefined,
    ANTHROPIC_BASE_URL: undefined,
    CLAUDE_CODE_USE_BEDROCK: undefined,
    CLAUDE_CODE_USE_VERTEX: undefined,
    CLAUDE_CODE_USE_FOUNDRY: undefined,
    ...extra,
  };
}

test('モックの会話を引き継いで Claude Code(偽)に切り替え、自由な文に応答し、失敗と中断を扱い、モックに戻せる', async ({ page, home }) => {
  const env = fakeEnv(home);
  const studio = await launchStudio(home, { env });
  try {
    await page.goto(studio.url);
    await page.getByRole('button', { name: /サンプル: 架空の求人相談/ }).click();
    const app = page.frameLocator('iframe[title="試作品"]');
    const details = page.locator('#ai-status');
    const log = app.getByRole('region', { name: '会話' }).getByRole('listitem');
    const conditions = app.getByRole('region', { name: '希望条件' }).locator('.value');
    const message = app.getByLabel('メッセージ');
    const alert = app.getByRole('alert');
    const type = async (text) => {
      await message.fill(text);
      await app.getByRole('button', { name: '送る' }).click();
    };
    const say = async (text) => {
      await type(text);
      await expect(message).toHaveValue('');
    };

    // 既定はモック
    await expect(page.locator('#ai-badge')).toHaveText('AI: モック');
    await say('カフェで働きたいです');
    await expect(log.last()).toContainText(AFTER_JOB);
    await expect(log.last()).toContainText('モック');

    // 切り替える前に、送り先、送るもの、費用を出し、確認を求める
    await page.getByRole('radio', { name: 'Claude Code' }).check();
    const confirm = page.getByRole('group', { name: 'Claude Code に切り替える前の確認' });
    await expect(confirm).toContainText('発言のたびに実際の AI モデルを呼びます');
    await expect(confirm).toContainText('送り先: Anthropic(Claude Code が送ります)');
    await expect(confirm.getByRole('list', { name: '送るもの' })).toContainText('会話の全体');
    await expect(confirm).toContainText('費用: Claude Code にログインしているアカウント');
    await expect(confirm).toContainText('ANTHROPIC_API_KEY がないので');
    // --max-budget-usd は 1 回の呼び出しごと。1 回の発言では多くて 4 回呼ぶ
    await expect(confirm).toContainText('1 回の呼び出しの上限は $0.1 です(--max-budget-usd)。1 回の発言で多くて 4 回呼ぶので、1 回の発言では多くて $0.4 です。');
    await confirm.getByText('送る指示の全文を見る').click();
    await expect(confirm.locator('pre')).toContainText('しおかぜ求人相談');
    const switchButton = confirm.getByRole('button', { name: 'Claude Code に切り替える' });
    await expect(switchButton).toBeDisabled();
    // やめると、モックのまま
    await confirm.getByRole('button', { name: 'やめる' }).click();
    await expect(confirm).toBeHidden();
    await expect(page.getByRole('radio', { name: 'モック' })).toBeChecked();
    expect(await readCalls(env.FAKE_CLAUDE_LOG)).toEqual([]);

    await page.getByRole('radio', { name: 'Claude Code' }).check();
    await confirm.getByRole('checkbox').check();
    await switchButton.click();
    await expect(page.locator('#ai-badge')).toHaveText('AI: Claude Code');
    await expect(page.locator('#events')).toContainText('接続を「Claude Code」にしました');
    await expect(app.locator('.note')).toContainText('案内役の AI は Claude Code(実際の AI モデル)です');
    // 選んでいる間は、送り先と費用がいつも見える
    await expect(details).toContainText('費用: Claude Code にログインしているアカウント');

    // 自由な文に応答する。モックとの会話(3 件)を引き継ぐ
    await say('雇用は正社員で、もみじ台あたりがいいな');
    await expect(log.last()).toContainText('偽の Claude Code です。これまでの会話を受け取りました(修正の記録なし)。');
    // 言い方に渡した会話は、モックとの会話の 3 件(偽の CLI の返事には、どこにも出てこない数を書かせない)
    const historyOf = (call) => /<これまでの会話>\n([\s\S]*?)\n<\/これまでの会話>/.exec(call.stdin)[1].split('\n');
    expect(historyOf((await readCalls(env.FAKE_CLAUDE_LOG)).at(-1))).toHaveLength(3);
    await expect(log.last()).toContainText('Claude Code');
    await expect(log.nth(2)).toContainText('モック');
    await expect(conditions).toHaveText(['カフェのホール', '正社員', 'もみじ台', '未定']);
    await expect(details.getByRole('definition')).toHaveText(['カフェのホール', '正社員', 'もみじ台', '未定']);
    // 費用の目安は、抽出と言い方の 2 回の呼び出しの合計
    await expect(details).toContainText(/最後の応答: Claude Code、[\d.]+ 秒、費用の目安 \$0\.0024/);

    // 本人の修正を履歴として渡す
    await app.getByLabel('勤務地を直す').selectOption('ひばり駅前');
    await expect(log.last()).toHaveText('あなたの修正: 勤務地を「ひばり駅前」に直しました。');
    await say('時給は1300円以上で');
    await expect(log.last()).toContainText('これまでの会話を受け取りました(修正の記録あり)');
    const afterCorrection = historyOf((await readCalls(env.FAKE_CLAUDE_LOG)).at(-1));
    expect(afterCorrection).toHaveLength(6);
    expect(afterCorrection.filter((line) => line.startsWith('[利用者の修正]'))).toHaveLength(1);
    await expect(conditions).toHaveText(['カフェのホール', '正社員', 'ひばり駅前', '1,300円以上']);
    await expect(log).toHaveCount(8);

    // 失敗: 利用の上限。会話は変わらず、書いた文は残る
    await type('[上限] もう一回');
    await expect(alert).toContainText('Claude Code の利用の上限に当たりました');
    await expect(page.locator('#events')).toContainText('利用の上限');
    await expect(message).toHaveValue('[上限] もう一回');
    await expect(log).toHaveCount(8);

    // 失敗: CLI が異常終了
    await type('[壊れる]');
    await expect(alert).toContainText('途中で止まりました');
    await expect(log).toHaveCount(8);

    // 中断: Studio の画面から止めると、CLI が終わり、会話は変わらない
    await type('[遅い] よく考えて');
    await expect(app.getByRole('status')).toHaveText('案内役が考えています…');
    await expect(details.getByRole('status')).toContainText('Claude Code の応答を待っています');
    await expect(page.getByRole('radio', { name: 'モック' })).toBeDisabled();
    await expect.poll(async () => (await readCalls(env.FAKE_CLAUDE_LOG)).some((c) => c.stdin.includes('[遅い] よく考えて'))).toBe(true);
    const slow = (await readCalls(env.FAKE_CLAUDE_LOG)).find((c) => c.stdin.includes('[遅い] よく考えて'));
    expect(alive(slow.pid)).toBe(true);
    await details.getByRole('button', { name: '応答を止める' }).click();
    await expect(alert).toHaveText('応答を止めました');
    await expect(app.getByRole('status')).toBeHidden();
    await expect(details.getByRole('status')).toBeHidden();
    await expect.poll(() => alive(slow.pid)).toBe(false);
    await expect(log).toHaveCount(8);

    // 開き直しても、会話と接続はそのまま
    await page.getByRole('button', { name: '開き直す' }).click();
    await expect(log).toHaveCount(8);
    await expect(page.locator('#ai-badge')).toHaveText('AI: Claude Code');

    // モックに戻すのに確認は要らない。会話は続く
    await page.getByRole('radio', { name: 'モック' }).check();
    await expect(page.locator('#ai-badge')).toHaveText('AI: モック');
    await expect(details).not.toContainText('費用:');
    await say('やっぱりアルバイトがいいです');
    await expect(log.last()).toContainText('雇用区分「アルバイト・パート」と理解しました。');
    await expect(log.last()).toContainText('モック');
    await expect(log).toHaveCount(10);

    // 偽の CLI が受け取ったもの: 閉じ込めのフラグ、道具なし、空の作業フォルダー、資格情報を足していないこと。
    // 応答した 2 回は抽出と言い方の 2 回ずつ、失敗した 3 回(上限、異常終了、中断)は抽出の 1 回ずつ
    const calls = await readCalls(env.FAKE_CLAUDE_LOG);
    const kindOf = (call) => (JSON.parse(call.argv.find((a) => a.startsWith('--json-schema=')).slice(14)).properties.reply ? 'phrase' : 'extract');
    expect(calls.map(kindOf)).toEqual(['extract', 'phrase', 'extract', 'phrase', 'extract', 'extract', 'extract']);
    for (const call of calls) {
      expect(call.argv).toEqual(expect.arrayContaining(['-p', '--restricted', '--safe-mode', '--strict-mcp-config', '--no-session-persistence']));
      expect(call.argv[call.argv.indexOf('--tools') + 1]).toBe('');
      expect(call.argv).toContain('--max-budget-usd');
      expect(call.envNames).not.toContain('ANTHROPIC_API_KEY');
      expect(call.cwd).not.toContain(home);
    }
    expect(studio.output()).not.toContain('偽の CLI');
  } finally {
    await studio.stop();
  }
});

test('応答を待つ間に開き直しても作り直しても、止められ、届いた応答は新しく開いた試作品に出る', async ({ page, home }) => {
  const env = fakeEnv(home);
  const studio = await launchStudio(home, { env });
  try {
    await page.goto(studio.url);
    await page.getByRole('button', { name: /サンプル: 架空の求人相談/ }).click();
    const app = page.frameLocator('iframe[title="試作品"]');
    const details = page.locator('#ai-status');
    const log = app.getByRole('region', { name: '会話' }).getByRole('listitem');
    const message = app.getByLabel('メッセージ');
    await page.getByRole('radio', { name: 'Claude Code' }).check();
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Claude Code に切り替える' }).click();
    await expect(app.locator('.note')).toContainText('Claude Code');

    // 開き直しても、待っていた応答は新しく開いた試作品に出る
    await message.fill('[少し遅い] 書店の売り場で働きたい');
    await app.getByRole('button', { name: '送る' }).click();
    await expect(details.getByRole('status')).toBeVisible();
    await page.getByRole('button', { name: '開き直す' }).click();
    await expect(log).toHaveCount(1);
    await expect(log.last()).toContainText('「[少し遅い] 書店の売り場で働きたい」への返事です', { timeout: 10_000 });
    await expect(app.getByRole('region', { name: '希望条件' }).locator('.value')).toHaveText(['書店の売り場', '未定', '未定', '未定']);
    await expect(details.getByRole('status')).toBeHidden();

    // 作り直しても「止める」は出たまま。押すと止まる
    await message.fill('[遅い] 考えて');
    await app.getByRole('button', { name: '送る' }).click();
    await expect(details.getByRole('status')).toBeVisible();
    await page.getByRole('button', { name: '作り直す' }).click();
    await expect(page.locator('#build-status')).toContainText('ビルドに成功しました');
    await details.getByRole('button', { name: '応答を止める' }).click();
    await expect(details.getByRole('status')).toBeHidden();
    await expect(page.getByRole('radio', { name: 'モック' })).toBeEnabled();
    const slow = (await readCalls(env.FAKE_CLAUDE_LOG)).find((c) => c.stdin.includes('[遅い] 考えて'));
    await expect.poll(() => alive(slow.pid)).toBe(false);
    await expect(log).toHaveCount(3);
  } finally {
    await studio.stop();
  }
});

test('実モデルは許されていなければ選べず、理由を出す。API キーがあれば従量課金と上限を出す', async ({ page, home }) => {
  const blocked = await launchStudio(home, { env: { ...fakeEnv(home), STUDIO_ALLOW_CLAUDE_CODE: undefined } });
  try {
    await expect.poll(() => blocked.output()).toContain('STUDIO_ALLOW_CLAUDE_CODE=1');
    await page.goto(blocked.url);
    await page.getByRole('button', { name: /サンプル: 架空の求人相談/ }).click();
    await expect(page.getByRole('radio', { name: 'Claude Code' })).toBeDisabled();
    await expect(page.locator('#ai-status')).toContainText('実際の AI モデルは、まだ使えない設定です');
    await expect(page.locator('#ai-badge')).toHaveText('AI: モック');
  } finally {
    await blocked.stop();
  }

  const paid = await launchStudio(home, { env: fakeEnv(home, { ANTHROPIC_API_KEY: 'test-placeholder-not-a-key' }) });
  try {
    await page.goto(paid.url);
    await page.getByRole('button', { name: /サンプル: 架空の求人相談/ }).click();
    await page.getByRole('radio', { name: 'Claude Code' }).check();
    const confirm = page.getByRole('group', { name: 'Claude Code に切り替える前の確認' });
    await expect(confirm).toContainText('費用: API の従量課金');
    await expect(confirm).toContainText('1 回の呼び出しの上限は $0.1 です');
    await expect(confirm).not.toContainText('test-placeholder-not-a-key');
  } finally {
    await paid.stop();
  }
});
