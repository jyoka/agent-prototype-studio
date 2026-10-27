import { useEffect, useRef, useState } from 'react';
import { matchJobs } from './jobs.js';

// プロダクト内 AI は、Studio の runtime が配る window.studio.ai から呼ぶ。
// 会話と希望条件は Studio が持つので、この画面は受け取った session を描くだけにする。
const ai = window.studio?.ai;
const VIA = { mock: 'モック', 'claude-code': 'Claude Code' };

function formatValue(field, value) {
  if (value === null || value === undefined) return '未定';
  return field.type === 'number' ? `${value.toLocaleString('ja-JP')}${field.unit}以上` : value;
}

function Message({ message }) {
  if (message.role === 'correction') {
    return <li className="correction">あなたの修正: {message.text}</li>;
  }
  const mine = message.role === 'user';
  return (
    <li className={mine ? 'user' : 'assistant'}>
      <span className="who">
        {mine ? 'あなた' : '案内役'}
        {message.via && <span className="via">{VIA[message.via] ?? message.via}</span>}
      </span>
      <p>{message.text}</p>
    </li>
  );
}

function ConditionRow({ field, value, disabled, onCorrect }) {
  const [draft, setDraft] = useState(value ?? '');
  useEffect(() => setDraft(value ?? ''), [value]);

  if (field.type === 'number') {
    return (
      <div className="condition">
        <dt>{field.label}</dt>
        <dd>
          <span className="value">{formatValue(field, value)}</span>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              onCorrect({ [field.key]: draft === '' ? null : Number(draft) });
            }}
          >
            <label>
              <span className="sr">{field.label}を直す</span>
              <input type="number" min={field.min ?? undefined} max={field.max ?? undefined} value={draft} onChange={(e) => setDraft(e.target.value)} disabled={disabled} />
            </label>
            <span>{field.unit}以上</span>
            <button type="submit" disabled={disabled}>
              直す
            </button>
          </form>
        </dd>
      </div>
    );
  }
  return (
    <div className="condition">
      <dt>{field.label}</dt>
      <dd>
        <span className="value">{formatValue(field, value)}</span>
        <label>
          <span className="sr">{field.label}を直す</span>
          <select value={value ?? ''} disabled={disabled} onChange={(e) => onCorrect({ [field.key]: e.target.value === '' ? null : e.target.value })}>
            <option value="">未定</option>
            {field.options.map((option) => (
              <option key={option}>{option}</option>
            ))}
          </select>
        </label>
      </dd>
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(ai ? '' : 'Studio の runtime がありません。Studio の画面から開いてください。');
  const logRef = useRef(null);

  useEffect(() => {
    ai?.session().then(setSession, (e) => setError(e.message));
    // Studio の画面で接続(モック、Claude Code)を切り替えたら、表示を変える
    return ai?.onChange?.(setSession);
  }, []);

  useEffect(() => {
    logRef.current?.lastElementChild?.scrollIntoView({ block: 'end' });
  }, [session?.messages.length]);

  async function run(action) {
    setBusy(true);
    setError('');
    try {
      setSession(await action());
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function send(event) {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setSending(true);
    const ok = await run(() => ai.send(text));
    setSending(false);
    if (ok) setDraft('');
  }

  const jobs = session ? matchJobs(session.state) : [];
  const isMock = session?.connection.kind === 'mock';

  return (
    <div className="app">
      <header>
        <h1>しおかぜ求人相談</h1>
        <p className="note">
          架空のサービスと架空の求人です。実在の企業や人とは関係ありません。
          {session &&
            (isMock
              ? ' 案内役の AI はモックで、決まった応答を返します。'
              : ` 案内役の AI は ${session.connection.label}(実際の AI モデル)です。送った文は AI の提供元に送られます。`)}
        </p>
      </header>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <div className="columns">
        <section className="chat" aria-label="会話">
          <ul className="log" ref={logRef}>
            {session?.messages.map((message, i) => <Message key={i} message={message} />)}
          </ul>
          {sending && (
            <p className="thinking" role="status">
              案内役が考えています…
            </p>
          )}
          <form onSubmit={send}>
            <label>
              <span className="sr">メッセージ</span>
              <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="例: しおかぜ町でカフェのアルバイトを探しています" disabled={!session || busy} />
            </label>
            <button type="submit" disabled={!session || busy || !draft.trim()}>
              送る
            </button>
          </form>
        </section>

        <aside className="side">
          <section aria-label="希望条件">
            <h2>希望条件</h2>
            <p className="hint">案内役が会話から理解した条件です。違うときは、ここで直せます。</p>
            {session && (
              <dl>
                {session.fields.map((field) => (
                  <ConditionRow key={field.key} field={field} value={session.state[field.key]} disabled={busy} onCorrect={(changes) => run(() => ai.correct(changes))} />
                ))}
              </dl>
            )}
          </section>
          <section aria-label="条件に合う求人">
            <h2>条件に合う求人(架空) {session && <span className="count">{jobs.length} 件</span>}</h2>
            <ul className="jobs">
              {jobs.map((job) => (
                <li key={job.id}>
                  <strong>{job.name}</strong>
                  <span>
                    {job.jobType} ・ {job.employmentType} ・ {job.area} ・ 時給 {job.wage.toLocaleString('ja-JP')}円
                  </span>
                </li>
              ))}
              {session && jobs.length === 0 && <li className="empty">合う求人がありません。条件を直してみてください。</li>}
            </ul>
          </section>
        </aside>
      </div>
    </div>
  );
}
