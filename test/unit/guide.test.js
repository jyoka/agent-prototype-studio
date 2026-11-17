import assert from 'node:assert/strict';
import test from 'node:test';
import { EXPLAINS, STATE_KINDS, STATES } from '../../src/ui/guide.js';

// 案内の言葉(docs/design/ui-ux-v2.md の 5.2、5.4、5.5、9 節)。画面に出す前の言葉を、決まりに合うかで確かめる

// 言わない語(5.5 と 9 節)。「!」は文の終わりの感嘆だけを数える(! だけの印は 5.4 の「承認が消えた」の印)
const BANNED = [/すごい/, /完璧/, /！/, /[\p{L}\p{N}。、)」]!/u, /\d+\s*[%％]\s*(完了|済|終わ|達成|進)/, /エラー\s*[:：]/, /本番で使える/, /理想の作り/, /誰でも\s*5\s*分で/];

const sentences = (text) => text.split(/(?<=[。?])/).filter((part) => part.trim());

test('12 の状態に、印と 3 つの文がある。文は 1 文ずつで、何が起きたか、今どうなっているか、次に何をするかの順', () => {
  assert.equal(STATE_KINDS.length, 12);
  for (const kind of STATE_KINDS) {
    const names = kind === 'mode' ? ['mode-trial', 'mode-real'] : [kind];
    for (const name of names) {
      const state = STATES[name];
      assert.ok(state, `${name} がありません`);
      assert.ok(state.mark.trim(), `${name} に印がありません`);
      const words = state.words({});
      assert.equal(words.length, 3, `${name} の文が 3 つではありません`);
      for (const text of words) {
        assert.equal(sentences(text).length, 1, `${name} の「${text}」が 1 文ではありません`);
        for (const word of BANNED) assert.doesNotMatch(text, word, `${name} の「${text}」に言わない語があります`);
      }
    }
  }
  // 5.4 の印
  assert.equal(STATES.reverted.mark, '↶');
  assert.equal(STATES.lost.mark, '!');
  assert.equal(STATES['mode-trial'].mark, '○');
  assert.equal(STATES['mode-real'].mark, '◉');
  assert.equal(STATES.consent.mark, '◉');
  assert.equal(STATES.customer.mark, '架空');
  assert.equal(STATES.guess.mark, '推測');
  assert.match(STATES['guard-stopped'].mark, /⬢ 止めました/);
  assert.match(STATES['gate-failed'].mark, /×.*⬢/);
});

test('数と名前は呼ぶ側が渡す。渡した数が文に入る', () => {
  assert.deepEqual(STATES.waiting.words({ approved: 2, total: 4, label: 'データと RAG ' }), [
    'あなたの承認を待っています。',
    '承認は 2 / 4 で、そろうまで作る AI は動きません。',
    'データと RAG を読み、違わなければ承認しますか。',
  ]);
  assert.equal(STATES.reverted.words({ at: '10:52' })[0], '10:52 の版に戻しました。');
  assert.equal(STATES.guess.words({ count: 2 })[0], '話に出ていない 2 つの項目を、推測で埋めました。');
  assert.equal(STATES.lost.words({ because: '技術の組を選び直した' })[0], '技術の組を選び直したので、この欄の承認を消しました。');
});

test('「これは何?」の 3 つの問いの答えは 1 文ずつ。言わない語がない。推測は「(推測)」と書く', () => {
  for (const [key, texts] of Object.entries(EXPLAINS)) {
    assert.ok(texts.name, `${key} に名前がありません`);
    for (const part of ['what', 'does', 'next']) {
      const text = texts[part];
      assert.ok(text, `${key} の ${part} がありません`);
      assert.equal(sentences(text).length, 1, `${key} の ${part}「${text}」が 1 文ではありません`);
      assert.match(text, /。$/, `${key} の ${part} は「。」で終わります`);
      for (const word of BANNED) assert.doesNotMatch(text, word, `${key} の ${part}「${text}」に言わない語があります`);
      // 推測と書くときは「(推測)」の形にする(「今日の推測です」のような名詞の使い方は除く)
      if (/推測\)|推測。$/.test(text)) assert.match(text, /\(推測\)/, `${key} の ${part} の推測は「(推測)」と書きます`);
    }
  }
});
