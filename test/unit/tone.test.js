import assert from 'node:assert/strict';
import test from 'node:test';
import { STUDIO_SYSTEM_PROMPT, buildClaudeArgs } from '../../src/server/claude-args.js';
import { extractPrompt, phrasePrompt } from '../../src/server/product-ai/claude-code.js';
import { parseAiDefinition } from '../../src/server/product-ai/definition.js';
import { agentPrompt } from '../../src/server/sim/agent-claude-code.js';
import { MAKER_TONE_RULE, PRODUCT_TONE_RULE } from '../../src/server/tone.js';

// 調子の決まり(docs/vision.md の 7 節)を、作る AI と試作品の中の AI への Studio の決まりに入れる(user-journey.md の J9)

function definition() {
  const { definition, errors } = parseAiDefinition(
    JSON.stringify({
      name: '旅の相談(架空)',
      instructions: '- 架空の旅行会社の案内役です。明るい口調で話します。',
      fields: [{ key: 'place', label: '行き先', options: [{ value: '湖の町', keywords: ['湖'] }] }],
      mock: { greeting: 'ようこそ。' },
    }),
  );
  assert.deepEqual(errors, []);
  return definition;
}

test('調子の決まりは vision.md の 7 節の中身を持つ: 事実と推測を分ける、測らない約束と褒めすぎと絵文字を使わない、謝るのは 1 回まで', () => {
  for (const rule of [MAKER_TONE_RULE, PRODUCT_TONE_RULE]) {
    assert.match(rule, /プロフェッショナルで、信頼できる|落ち着いて事実を伝える/);
    assert.match(rule, /推測/);
    assert.match(rule, /「最高」「完璧」/);
    assert.match(rule, /「誰でも」「5 分で」/);
    assert.match(rule, /絵文字/);
    assert.match(rule, /謝るのは 1 回まで/);
    assert.match(rule, /何が起きたか、今どうなっているか、次にすること/);
  }
  // 作る AI は報告の書き方と、数の出どころも決める
  assert.match(MAKER_TONE_RULE, /した事実、確かめた範囲、確かめていないこと/);
  assert.match(MAKER_TONE_RULE, /出典があるものか測った値だけ/);
  // 試作品の中の AI は、作り手の人柄と口調を消さない
  assert.match(PRODUCT_TONE_RULE, /作り手が書いた人柄と口調に従いながら/);
});

test('作る AI: 起動のたびに渡す Studio の決まりに、調子の決まりが入る(素材の指針の前)', () => {
  assert.ok(STUDIO_SYSTEM_PROMPT.includes(MAKER_TONE_RULE));
  const args = buildClaudeArgs({ billing: { mode: 'login' }, mcpConfig: '/x/mcp.json' });
  const prompt = args[args.indexOf('--append-system-prompt') + 1];
  assert.ok(prompt.includes(MAKER_TONE_RULE));
  assert.ok(prompt.indexOf(MAKER_TONE_RULE) < prompt.indexOf('## 既定の素材の指針'));
});

test('試作品の中の AI: 言い方の指示と模擬のエージェントの決まりに入り、読み取りの係(返事を書かない)には入らない', () => {
  const def = definition();
  const phrase = phrasePrompt(def);
  assert.ok(phrase.includes(PRODUCT_TONE_RULE));
  // 作り手の指示は先に、そのまま残る
  assert.ok(phrase.startsWith('- 架空の旅行会社の案内役です。明るい口調で話します。'));
  assert.ok(!extractPrompt(def).includes(PRODUCT_TONE_RULE));

  const participant = { id: 'guide', prompt: [{ slot: 'ours-guide', owner: 'ours', text: 'あなたは架空の案内役です。' }] };
  const { text } = agentPrompt({ participant, assumption: {} });
  assert.ok(text.includes(PRODUCT_TONE_RULE));
  assert.ok(text.indexOf('あなたは架空の案内役です。') < text.indexOf(PRODUCT_TONE_RULE));
});
