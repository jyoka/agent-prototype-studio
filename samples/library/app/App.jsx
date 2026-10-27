import { useMemo, useState } from 'react';
import { GENRES, INITIAL_BOOKS } from './data.js';

const ALL = 'すべて';

export default function App() {
  const [books, setBooks] = useState(INITIAL_BOOKS);
  const [query, setQuery] = useState('');
  const [genre, setGenre] = useState(ALL);
  const [selectedId, setSelectedId] = useState(INITIAL_BOOKS[0].id);
  const [draft, setDraft] = useState({ title: '', author: '', genre: GENRES[0] });

  const visible = useMemo(() => {
    const q = query.trim();
    return books.filter(
      (book) =>
        (genre === ALL || book.genre === genre) && (q === '' || book.title.includes(q) || book.author.includes(q)),
    );
  }, [books, query, genre]);

  const selected = books.find((book) => book.id === selectedId) ?? null;
  const availableCount = books.filter((book) => book.available).length;

  function toggleLoan(id) {
    setBooks((current) => current.map((book) => (book.id === id ? { ...book, available: !book.available } : book)));
  }

  function addBook(event) {
    event.preventDefault();
    const title = draft.title.trim();
    const author = draft.author.trim();
    if (!title || !author) return;
    const id = Math.max(...books.map((book) => book.id)) + 1;
    setBooks((current) => [
      ...current,
      { id, title, author, genre: draft.genre, year: new Date().getFullYear(), available: true, summary: '新しく登録した本です。' },
    ]);
    setSelectedId(id);
    setDraft({ title: '', author: '', genre: draft.genre });
  }

  return (
    <div className="app">
      <header>
        <h1>こもれび図書室</h1>
        <p className="note">架空のデータです。実在の本や人物とは関係ありません。</p>
        <p className="summary" aria-live="polite">
          全 {books.length} 冊、貸出できる本 {availableCount} 冊
        </p>
      </header>

      <div className="filters">
        <label>
          書名か著者で探す
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="例: 雲" />
        </label>
        <div role="group" aria-label="分野">
          {[ALL, ...GENRES].map((g) => (
            <button key={g} type="button" aria-pressed={genre === g} onClick={() => setGenre(g)}>
              {g}
            </button>
          ))}
        </div>
      </div>

      <div className="columns">
        <ul className="books" aria-label="本の一覧">
          {visible.map((book) => (
            <li key={book.id}>
              <button type="button" aria-current={book.id === selectedId} onClick={() => setSelectedId(book.id)}>
                <span className="title">{book.title}</span>
                <span className="meta">
                  {book.author} ・ {book.genre}
                </span>
                <span className={book.available ? 'badge ok' : 'badge out'}>{book.available ? '貸出できます' : '貸出中'}</span>
              </button>
            </li>
          ))}
          {visible.length === 0 && <li className="empty">見つかりませんでした</li>}
        </ul>

        <section className="detail" aria-label="本の詳細">
          {selected ? (
            <>
              <h2>{selected.title}</h2>
              <p className="meta">
                {selected.author} ・ {selected.genre} ・ {selected.year} 年
              </p>
              <p>{selected.summary}</p>
              <p className="status">{selected.available ? 'この本は貸出できます。' : 'この本は貸出中です。'}</p>
              <button type="button" className="primary" onClick={() => toggleLoan(selected.id)}>
                {selected.available ? '借りる' : '返す'}
              </button>
            </>
          ) : (
            <p>本を選んでください。</p>
          )}
        </section>
      </div>

      <form className="add" onSubmit={addBook} aria-label="本を登録する">
        <h2>本を登録する</h2>
        <label>
          書名
          <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} required />
        </label>
        <label>
          著者
          <input value={draft.author} onChange={(e) => setDraft({ ...draft, author: e.target.value })} required />
        </label>
        <label>
          分野
          <select value={draft.genre} onChange={(e) => setDraft({ ...draft, genre: e.target.value })}>
            {GENRES.map((g) => (
              <option key={g}>{g}</option>
            ))}
          </select>
        </label>
        <button type="submit" className="primary">
          登録する
        </button>
      </form>
    </div>
  );
}
