import { useEffect, useRef, useState } from 'react';
import { matchCourses, weeklyPlan } from './courses.js';

// プロダクト内 AI は、Studio の runtime が配る window.studio.ai から呼ぶ。
// 会話と学習の希望は Studio が持つので、この画面は受け取った session を描くだけにする。
const ai = window.studio?.ai;
const VIA = { mock: 'モック', 'claude-code': 'Claude Code' };
// 狭い画面では、1 週間の進め方の要約を会話の上に出す
const NARROW = window.matchMedia?.('(max-width: 700px)').matches ?? false;

function formatValue(field, value) {
  if (value === null || value === undefined) return '未定';
  return field.type === 'number' ? `${value.toLocaleString('ja-JP')}${field.unit}` : value;
}

function Message({ message }) {
  if (message.role === 'correction') {
    return <li className="correction">あなたの修正: {message.text}</li>;
  }
  const mine = message.role === 'user';
  return (
    <li className={mine ? 'user' : 'assistant'}>
      <span className="who">
        {mine ? 'あなた' : '相談役'}
        {message.via && <span className="via">{VIA[message.via] ?? message.via}</span>}
      </span>
      <p>{message.text}</p>
    </li>
  );
}

function PlanRow({ field, value, disabled, onCorrect }) {
  const [draft, setDraft] = useState(value ?? '');
  useEffect(() => setDraft(value ?? ''), [value]);

  if (field.type === 'number') {
    return (
      <div className="plan-row">
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
            <span>{field.unit}</span>
            <button type="submit" disabled={disabled}>
              直す
            </button>
          </form>
        </dd>
      </div>
    );
  }
  return (
    <div className="plan-row">
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

  const courses = session ? matchCourses(session.state) : [];
  const plan = session ? weeklyPlan(session.state, courses[0]) : null;
  const isMock = session?.connection.kind === 'mock';

  return (
    <div className="app">
      <header>
        <h1>あおぞら学習相談</h1>
        <p className="note">
          架空のサービスと架空の講座です。実在の学校や人とは関係ありません。
          {session &&
            (isMock
              ? ' 相談役の AI はモックで、決まった応答を返します。'
              : ` 相談役の AI は ${session.connection.label}(実際の AI モデル)です。送った文は AI の提供元に送られます。`)}
        </p>
      </header>

      {NARROW && <p className="summary">1 週間で {plan.totalMinutes.toLocaleString('ja-JP')} 分</p>}

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
              相談役が考えています…
            </p>
          )}
          <form onSubmit={send}>
            <label>
              <span className="sr">メッセージ</span>
              <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="例: 英会話を始めたいです。1日30分くらい使えます" disabled={!session || busy} />
            </label>
            <button type="submit" disabled={!session || busy || !draft.trim()}>
              送る
            </button>
          </form>
        </section>

        <aside className="side">
          <section aria-label="学習プラン">
            <h2>学習プラン</h2>
            <p className="hint">相談役が会話から理解した内容です。違うときは、ここで直せます。</p>
            {session && (
              <dl>
                {session.fields.map((field) => (
                  <PlanRow key={field.key} field={field} value={session.state[field.key]} disabled={busy} onCorrect={(changes) => run(() => ai.correct(changes))} />
                ))}
              </dl>
            )}
            <p className="week" aria-label="1 週間の進め方">
              {plan
                ? `1 週間で ${plan.totalMinutes.toLocaleString('ja-JP')} 分。「${courses[0].name}」を 1 日 ${plan.perDay} 回、週 ${plan.perWeek} 回。`
                : '1 日に使える時間と、合う講座が決まると、1 週間の進め方が出ます。'}
            </p>
          </section>
          <section aria-label="合う講座">
            <h2>合う講座(架空) {session && <span className="count">{courses.length} 件</span>}</h2>
            <ul className="courses">
              {courses.map((course) => (
                <li key={course.id}>
                  <strong>{course.name}</strong>
                  <span>
                    {course.subject} ・ {course.level} ・ {course.style} ・ 1 回 {course.minutes} 分
                  </span>
                </li>
              ))}
              {session && courses.length === 0 && <li className="empty">合う講座がありません。学習プランを直してみてください。</li>}
            </ul>
          </section>
        </aside>
      </div>
    </div>
  );
}
