// 最初の一歩の案内(docs/design/ux-redesign.md の 2 節、7-1、7-4)。手順の進み方と、案内を閉じたことを、Studio のメモリーにだけ持つ。
// 新しい保存の仕組みは足さない。Studio を起動し直すと、どちらも消える(案内がまた出る)。
//   1 番(試す): 試作品の中の AI に 1 回話すと済む。AI のない試作品では、試作品の画面を触ると済む(画面が知らせる)
//   2 番(言葉で直す): 直す AI の依頼が、作るループを通って passed、fixed、unverified のどれかで終わると済む。failed では済まない
//   3 番(直った結果を試す): 2 番が済んだ後に、同じ発言で試し直すか、もう一度話すか触ると済む
// 2 番の済みは、直す AI の依頼の一覧(BuildRequests の runs。これもメモリーだけ)から毎回読む。statusesOf(projectId) は、その状態の並び
export const FIXED_STATUSES = new Set(['passed', 'fixed', 'unverified']);

export class FirstSteps {
  constructor({ statusesOf }) {
    this.statusesOf = statusesOf;
    this.dismissed = false;
    // 試作品ごとの { tried, triedFixed }
    this.projects = new Map();
  }

  // 「閉じる」。Studio を止めるまで覚える
  dismiss() {
    this.dismissed = true;
    return this.state();
  }

  // 会のデータを消した後に呼ぶ
  forget(id) {
    this.projects.delete(id);
  }

  state() {
    return { dismissed: this.dismissed };
  }

  fixed(projectId) {
    return this.statusesOf(projectId).some((status) => FIXED_STATUSES.has(status));
  }

  // 試した(話した、試し直した、AI のない試作品の画面を触った)。直す AI の依頼が済んだ後なら、直った結果も試したことにする
  tried(projectId) {
    const progress = this.projects.get(projectId) ?? { tried: false, triedFixed: false };
    progress.tried = true;
    if (this.fixed(projectId)) progress.triedFixed = true;
    this.projects.set(projectId, progress);
  }

  // 試作品ごとの手順の済み。lastRun は、終わった最後の依頼の状態(failed のとき、画面は結果の帯を見るように案内する)
  view(projectId) {
    const statuses = this.statusesOf(projectId);
    const progress = this.projects.get(projectId);
    return {
      tried: Boolean(progress?.tried),
      fixed: statuses.some((status) => FIXED_STATUSES.has(status)),
      triedFixed: Boolean(progress?.triedFixed),
      lastRun: statuses.findLast((status) => status !== 'running') ?? null,
    };
  }
}
