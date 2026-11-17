import fs from 'node:fs/promises';
import path from 'node:path';

// 「その場で」の 1 行(docs/design/ui-ux-v2.md の 5.1)を、覚えたら出さないための回数。
// 置き場所は Studio のデータの置き場の hints.json(利用者ごと。試作品のフォルダーには入れない)。
// 中身は操作の種類ごとの回数だけ。利用者の書いた文、試作品の名前、時刻は入れない。
// 同じ種類の操作を SEEN_LIMIT 回したら、画面はその種類の 1 行を出さない。「案内をもう一度出す」で全部を 0 に戻す
export const SEEN_LIMIT = 2;
const KIND = /^[a-z][a-z0-9-]{0,39}$/;
const MAX_KINDS = 100;

export class Hints {
  // home は Studio のデータの置き場。null ならメモリーにだけ持つ(テスト用)
  constructor({ home = null } = {}) {
    this.file = home ? path.join(home, 'hints.json') : null;
    this.counts = Object.create(null);
    // 書き込みは 1 つずつ順に行う(同時の POST で、途中のファイルを読ませない)
    this.writing = Promise.resolve();
  }

  async load() {
    if (!this.file) return;
    this.counts = Object.create(null);
    try {
      const saved = JSON.parse(await fs.readFile(this.file, 'utf8'));
      for (const [kind, count] of Object.entries(saved?.counts ?? {})) {
        if (KIND.test(kind) && Number.isInteger(count) && count > 0) this.counts[kind] = Math.min(count, SEEN_LIMIT);
      }
    } catch {
      // ない、壊れている、読めないときは、どの 1 行も出す(案内が出すぎる方に倒す)。案内のために Studio を止めない
      this.counts = Object.create(null);
    }
  }

  async save() {
    if (!this.file) return;
    const body = `${JSON.stringify({ counts: { ...this.counts } }, null, 2)}\n`;
    const write = async () => {
      const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(tmp, body);
      await fs.rename(tmp, this.file);
    };
    this.writing = this.writing.catch(() => {}).then(write);
    return this.writing;
  }

  static validKind(kind) {
    return typeof kind === 'string' && KIND.test(kind);
  }

  // 操作を 1 回した。SEEN_LIMIT より上は数えない
  async seen(kind) {
    if (!Hints.validKind(kind)) throw new TypeError('操作の種類は、英小文字と数字とハイフンで 40 文字までです');
    if (!Object.hasOwn(this.counts, kind) && Object.keys(this.counts).length >= MAX_KINDS) return this.state();
    const next = Math.min((this.counts[kind] ?? 0) + 1, SEEN_LIMIT);
    if (next !== this.counts[kind]) {
      this.counts[kind] = next;
      await this.save();
    }
    return this.state();
  }

  // 「案内をもう一度出す」
  async reset() {
    this.counts = Object.create(null);
    await this.save();
    return this.state();
  }

  state() {
    return { limit: SEEN_LIMIT, counts: { ...this.counts } };
  }
}
