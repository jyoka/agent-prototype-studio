// Studio が同梱する会話の枠(docs/design/agent-simulation.md の 3.8)。試作品は import { Talk } from 'studio-talk' で使う。
// 試作品の iframe の中で動き、window.studio.ai(src/runtime/runtime.js)だけを呼ぶ。外へ通信しない(ADR-0001)。
// 部品(kind)は text、buttons、card、carousel、notice の 5 つ。見た目(theme)は talk、web、plain の 3 つ。
// どの部品を返すかは、会話の進め方が前提の messageTypes で決める。使えない部品は、サーバーで文に落ちて届く(sim-4 の parts.js)。
// 特定の会社のアプリの見た目(ロゴ、商標、色の組み合わせ)は写さない。
// 試作品のビルド(esbuild)が JSX を通さずに読めるよう、JSX を使わずに書く。
import { createElement as h, useCallback, useEffect, useRef, useState } from 'react';
import './talk.css';

export const TALK_THEMES = ['talk', 'web', 'plain'];
export const TALK_PART_KINDS = ['text', 'buttons', 'card', 'carousel', 'notice'];

// 返事の印。利用者の画面の言葉(docs/design/ux-redesign.md の 4 節)
const VIA = { mock: 'お試しの AI', 'claude-code': '本物の AI' };

const studioAi = () => (typeof window === 'undefined' ? undefined : window.studio?.ai);

// 会話の状態と送り方。Talk に渡すほか、試作品の画面で記録の店(session.records)を出すときにも使う。
// 返す: { session, busy, error, send(text, { action }) }。send は送れたら true
export function useStudioTalk() {
  const ai = studioAi();
  const [session, setSession] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(ai ? '' : 'Studio の runtime がありません。Studio の画面から開いてください。');

  useEffect(() => {
    if (!ai) return undefined;
    ai.session().then(setSession, (e) => setError(e.message));
    // Studio の画面で接続(お試しの AI、本物の AI)を切り替えたら、表示を変える
    return ai.onChange?.(setSession);
  }, []);

  const send = useCallback(async (text, options) => {
    if (!ai) return false;
    setBusy(true);
    setError('');
    try {
      setSession(await ai.send(text, options));
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  return { session, busy, error, send };
}

// ボタン。押すと、ボタンの文を発言として、action があれば一緒に送る(3.9)。
// 役割 button と名前(ボタンの文)で指せるので、観察器のシナリオの click で押せる(S4)。
// 前のターンの選択肢は押せない印(chip)にして、同じ名前のボタンが画面に 2 つ並ばないようにする
function Buttons({ items, active, disabled, onPress, label = '選択肢' }) {
  if (!active) {
    return h(
      'div',
      { className: 'studio-talk__buttons studio-talk__buttons--past' },
      items.map((item, i) => h('span', { key: i, className: 'studio-talk__chip' }, item.label)),
    );
  }
  return h(
    'div',
    { className: 'studio-talk__buttons', role: 'group', 'aria-label': label },
    items.map((item, i) =>
      h(
        'button',
        { key: i, type: 'button', className: 'studio-talk__button', disabled, onClick: () => onPress(item) },
        item.label,
      ),
    ),
  );
}

function Card({ card, active, disabled, onPress }) {
  return h(
    'article',
    { className: 'studio-talk__card', 'aria-label': card.title },
    h('h3', { className: 'studio-talk__card-title' }, card.title),
    card.text ? h('p', { className: 'studio-talk__card-text' }, card.text) : null,
    card.items?.length ? h(Buttons, { items: card.items, active, disabled, onPress, label: `${card.title}の選択肢` }) : null,
  );
}

// 返事の部品を描く。知らない部品は描かない(サーバーが形をそろえて返すので、ふつうは来ない)
export function TalkPart({ part, active = false, disabled = false, onPress = () => {} }) {
  switch (part?.kind) {
    case 'text':
      return h('p', { className: 'studio-talk__text' }, part.text);
    case 'notice':
      return h('p', { className: 'studio-talk__notice', role: 'note' }, part.text);
    case 'buttons':
      return h(Buttons, { items: part.items ?? [], active, disabled, onPress });
    case 'card':
      return h(Card, { card: part, active, disabled, onPress });
    case 'carousel':
      return h(
        'div',
        { className: 'studio-talk__carousel', role: 'group', 'aria-label': 'カードの一覧' },
        (part.cards ?? []).map((card, i) => h(Card, { key: i, card, active, disabled, onPress })),
      );
    default:
      return null;
  }
}

const partsOf = (message) => (Array.isArray(message.parts) && message.parts.length > 0 ? message.parts : [{ kind: 'text', text: message.text ?? '' }]);

function Message({ message, speaker, active, disabled, onPress }) {
  if (message.role === 'correction') {
    return h('li', { className: 'studio-talk__item studio-talk__item--correction' }, `あなたの修正: ${message.text}`);
  }
  if (message.role === 'user') {
    return h(
      'li',
      { className: 'studio-talk__item studio-talk__item--user' },
      h('span', { className: 'studio-talk__who' }, 'あなた'),
      h('p', { className: 'studio-talk__bubble' }, message.text),
    );
  }
  return h(
    'li',
    { className: 'studio-talk__item studio-talk__item--assistant' },
    h(
      'span',
      { className: 'studio-talk__who' },
      speaker,
      message.via ? h('span', { className: 'studio-talk__via' }, VIA[message.via] ?? message.via) : null,
    ),
    h(
      'div',
      { className: 'studio-talk__bubble' },
      partsOf(message).map((part, i) => h(TalkPart, { key: i, part, active, disabled, onPress })),
    ),
  );
}

function connectionNote(session) {
  if (!session) return '';
  if (session.connection?.kind === 'mock') return 'いまの案内役はお試しの AI です。決まった言葉だけ分かります。';
  return `いまの案内役は本物の AI(${session.connection?.label ?? '実際の AI モデル'})です。送った文は AI の提供元に送られます。`;
}

// トーク風の会話の枠。試作品の画面に置くだけで、Studio の会話(studio.ai)と話せる。
//   theme:       見た目。talk(トークのアプリ風)、web(Web のチャット風)、plain。書かなければ構成の surface.theme、それもなければ talk
//   title:       見出し(なくてよい)
//   note:        見出しの下の注意書き。接続の説明(お試しの AI か本物の AI か)の前に出す
//   starters:    会話がまだないときに出す、押すと送れる発言の例
//   placeholder: 入力欄の例
//   talk:        useStudioTalk() の戻り値。試作品の画面で記録の店も出すときに渡す(なければ Talk が自分で持つ)
export function Talk(props) {
  return props.talk ? h(TalkView, props) : h(OwnTalk, props);
}

function OwnTalk(props) {
  return h(TalkView, { ...props, talk: useStudioTalk() });
}

function TalkView({ theme, title, note = '', starters = [], placeholder = '', talk }) {
  const { session, busy, error, send } = talk;
  const [draft, setDraft] = useState('');
  const logRef = useRef(null);
  const wanted = theme ?? session?.surface?.theme;
  const shown = TALK_THEMES.includes(wanted) ? wanted : 'talk';
  const messages = session?.messages ?? [];

  useEffect(() => {
    logRef.current?.lastElementChild?.scrollIntoView?.({ block: 'end' });
  }, [messages.length]);

  // 参加者の名前。構成のない会話(構成 B)では参加者がないので、「案内役」にする
  const labels = new Map((session?.participants ?? []).map((p) => [p.id, p.label]));
  const speakerOf = (message) => labels.get(message.from) ?? '案内役';
  // 押せるのは、最後の利用者の発言の後の返事の選択肢だけ
  const lastUser = messages.map((m) => m.role).lastIndexOf('user');
  const press = (item) => send(item.label, item.action ? { action: item.action } : undefined);

  const items = [];
  let previous = null;
  messages.forEach((message, i) => {
    if (message.role === 'assistant') {
      // 話す参加者が替わったら、Studio の知らせ(notice)を挟む(引き継ぎ)
      if (previous !== null && message.from && previous !== message.from) {
        items.push(h('li', { key: `notice-${i}`, className: 'studio-talk__item studio-talk__item--notice' }, h('p', { className: 'studio-talk__notice', role: 'note' }, `${speakerOf(message)}に代わりました`)));
      }
      previous = message.from ?? previous;
    }
    items.push(h(Message, { key: i, message, speaker: speakerOf(message), active: i > lastUser, disabled: busy, onPress: press }));
  });

  async function submit(event) {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    if (await send(text)) setDraft('');
  }

  const fullNote = [note, connectionNote(session)].filter(Boolean).join(' ');
  return h(
    'section',
    { className: `studio-talk studio-talk--${shown}`, 'aria-label': '会話' },
    title || fullNote
      ? h(
          'header',
          { className: 'studio-talk__header' },
          title ? h('h1', { className: 'studio-talk__title' }, title) : null,
          fullNote ? h('p', { className: 'studio-talk__note' }, fullNote) : null,
        )
      : null,
    error ? h('p', { className: 'studio-talk__error', role: 'alert' }, error) : null,
    h(
      'ol',
      { className: 'studio-talk__log', ref: logRef, 'aria-label': 'やりとり' },
      items,
    ),
    session && messages.length === 0 && starters.length > 0
      ? h(Buttons, { items: starters.map((label) => ({ label })), active: true, disabled: busy, onPress: press, label: '話しかける例' })
      : null,
    busy ? h('p', { className: 'studio-talk__thinking', role: 'status' }, '考えています…') : null,
    h(
      'form',
      { className: 'studio-talk__form', onSubmit: submit },
      h(
        'label',
        { className: 'studio-talk__field' },
        h('span', { className: 'studio-talk__sr' }, 'メッセージ'),
        h('input', { value: draft, onChange: (e) => setDraft(e.target.value), placeholder, disabled: !session || busy }),
      ),
      h('button', { type: 'submit', className: 'studio-talk__send', disabled: !session || busy || !draft.trim() }, '送る'),
    ),
  );
}
