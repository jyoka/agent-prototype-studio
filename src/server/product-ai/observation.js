// 観察用の ai 関数を作る(docs/design/harness.md の 3.4)。呼ぶ側が作って observe() に渡す。
// 観察器(src/observer/)は AiSessions を import しない(S2)ので、ここは観察器のフォルダーに置かない。
//
// 観察の会話は、最初の要求で新しく作り、close() で捨てる(S15)。利用者の試す画面の会話、選んだ接続、
// 版、試し直しの前の会話には触れない。接続の既定はモック。
// やり取りは AI の実行の記録に「観察から」の印で残り、entries() で同じ形のまま取り出せる(report の ai)。
export function createObservationAi(aiSessions, projectId, { connection = 'mock' } = {}) {
  // 使えない接続(ない接続、実モデル)は、観察を始める前に断る
  aiSessions.observationConnection(connection);
  let conversation = null;
  let closed = false;
  let last = [];

  const open = () => {
    if (closed) throw Object.assign(new Error('観察はもう終わっています'), { code: 'closed' });
    conversation ??= aiSessions.openObservation(projectId, { connection });
    return conversation;
  };

  // request は観察器が確かめた { op: 'session' | 'send' | 'correct', text?, action?, changes? }
  const ai = async (request) => {
    const id = open();
    if (request.op === 'send') return aiSessions.send(projectId, request.text, { conversation: id, action: request.action });
    if (request.op === 'correct') return aiSessions.correct(projectId, request.changes, { conversation: id });
    return aiSessions.view(projectId, { conversation: id });
  };

  ai.conversation = () => conversation;
  // 観察の会話の今の状態(確かめ aiState に使う)。会話がまだ始まっていなければ null
  ai.state = () => (conversation && !closed ? aiSessions.view(projectId, { conversation }).state : null);
  // 観察の中のやり取りを、古い方から。close() の後も、閉じたときの記録を返す
  ai.entries = () => (conversation && !closed ? aiSessions.observationTrace(projectId, conversation) : last.map((entry) => structuredClone(entry)));
  ai.close = () => {
    if (closed) return;
    if (conversation) {
      last = aiSessions.observationTrace(projectId, conversation);
      aiSessions.closeObservation(projectId, conversation);
    }
    closed = true;
  };
  return ai;
}
