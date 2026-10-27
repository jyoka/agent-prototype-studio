#!/usr/bin/env node
// 偽の Claude Code。実モデルは呼ばない。STUDIO_CLAUDE_BIN でこのファイルを指すと、Studio はこれを起動する。
// 本物と同じ `-p --output-format json --json-schema …` の結果を出す。発言の中の合図で、失敗と遅延を再現する。
//   [遅い]   止められるまで応答しない(中断と時間切れ)
//   [しぶとい] [遅い] に加えて SIGINT を無視する(SIGTERM、SIGKILL まで段階を進めるか)
//   [少し遅い] 1.5 秒待ってから応答する(待つ間の画面の操作)
//   [上限]   利用の上限に当たったときの結果を出す
//   [壊れる] 終了コード 2 で止まる
//   [文だけ] 構造化出力を出さず、本文に JSON を書く(代わりの方法)
//   [鍵を出す] API キーらしい文字列を含むエラーを出して終了コード 1 で止まる(画面と記録で伏せるか)
//   [範囲外] 項目の決まりに合わない値と、ない項目を返す(状態に入れないか)
// FAKE_CLAUDE_LOG があれば、受け取った argv、cwd、stdin、関係する環境変数の「名前」を 1 行ずつ書く(値は書かない)。
import fs from 'node:fs';

const argv = process.argv.slice(2);
const REQUIRED = ['-p', '--restricted', '--safe-mode', '--strict-mcp-config', '--no-session-persistence'];

function option(name) {
  const joined = argv.find((arg) => arg.startsWith(`${name}=`));
  if (joined) return joined.slice(name.length + 1);
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (stdin += chunk));
process.stdin.on('end', main);

function section(name) {
  const match = new RegExp(`<${name}>\\n([\\s\\S]*?)\\n</${name}>`).exec(stdin);
  return match ? match[1] : '';
}

function main() {
  if (process.env.FAKE_CLAUDE_LOG) {
    const envNames = Object.keys(process.env).filter((name) => /ANTHROPIC|CLAUDE/.test(name)).sort();
    fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ pid: process.pid, argv, cwd: process.cwd(), envNames, stdin })}\n`);
  }
  const missing = REQUIRED.filter((name) => !argv.includes(name));
  if (missing.length > 0 || option('--tools') !== '' || option('--output-format') !== 'json') {
    process.stderr.write(`偽の CLI: 引数が足りません: ${missing.join(' ')}\n`);
    process.exit(3);
  }
  const text = section('新しい発言');
  if (text.includes('[しぶとい]')) process.on('SIGINT', () => {});
  if (text.includes('[遅い]') || text.includes('[しぶとい]')) {
    setInterval(() => {}, 1000);
    return;
  }
  if (text.includes('[少し遅い]')) {
    setTimeout(answer, 1500, text);
    return;
  }
  if (text.includes('[上限]')) {
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your limit · resets 3am" }));
    process.exit(1);
  }
  if (text.includes('[鍵を出す]')) {
    process.stderr.write('Invalid API key: sk-ant-api03-FAKEKEYFAKEKEY1234 (fake)\n');
    process.exit(1);
  }
  if (text.includes('[壊れる]')) {
    process.stderr.write('偽の CLI: 途中で止まりました\n');
    process.exit(2);
  }

  answer(text);
}

function answer(text) {
  // 本物のモデルの代わりに、スキーマの選択肢と数の範囲だけで値を読み取る
  const schema = JSON.parse(option('--json-schema'));
  const updates = {};
  for (const [key, property] of Object.entries(schema.properties.updates.properties)) {
    if (property.enum) {
      const found = property.enum.find((value) => value !== null && text.includes(value));
      if (found) updates[key] = found;
    } else {
      const numbers = [...text.matchAll(/\d+/g)].map((m) => Number(m[0]));
      const found = numbers.find((n) => (property.minimum ?? -Infinity) <= n && n <= (property.maximum ?? Infinity));
      if (found !== undefined) updates[key] = found;
    }
  }
  if (text.includes('[範囲外]')) {
    for (const [key, property] of Object.entries(schema.properties.updates.properties)) {
      updates[key] = property.enum ? 'ない選択肢' : (property.maximum ?? 0) + 1;
    }
    updates.unknownField = 'x';
  }
  const history = section('これまでの会話').split('\n').filter((line) => line.startsWith('['));
  const corrections = history.filter((line) => line.startsWith('[利用者の修正]')).length;
  const reply = `偽の Claude Code です。これまでの会話 ${history.length} 件(修正 ${corrections} 件)を受け取りました。「${text}」への返事です。`;
  const output = { reply, updates };
  const result = { type: 'result', subtype: 'success', is_error: false, duration_ms: 5, total_cost_usd: 0.0012 };
  if (text.includes('[文だけ]')) result.result = JSON.stringify(output);
  else Object.assign(result, { result: '', structured_output: output });
  process.stdout.write(JSON.stringify(result));
}
