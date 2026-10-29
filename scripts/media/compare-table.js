// 場面を回した比べる表(scripts/sim-compare.js の report.md の「比べる表(4.3)」)を、撮るための 1 枚の HTML にする。
// 色と字は assets/brand/tokens.css(ダークとライトは prefers-color-scheme)。外から何も読み込まない

const escapeHtml = (text) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());

// report.md から、見出しが heading で始まる節の最初の表を { head, rows } で返す
export function readTable(markdown, heading) {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`## ${heading}`));
  if (start === -1) throw new Error(`report.md に「${heading}」の節がありません`);
  const table = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) break;
    if (line.startsWith('|')) table.push(line);
    else if (table.length > 0) break;
  }
  if (table.length < 3) throw new Error(`「${heading}」の節に表がありません`);
  const [head, , ...rows] = table.map(cells);
  return { head, rows };
}

// drop に書いた列(見出しの文字)を外す。回すたびに変わる列(待ち時間)は、撮る絵に入れない
export function dropColumns({ head, rows }, drop) {
  const keep = head.map((name, index) => (drop.includes(name) ? -1 : index)).filter((index) => index !== -1);
  return { head: keep.map((i) => head[i]), rows: rows.map((row) => keep.map((i) => row[i])) };
}

export function compareTableHtml({ head, rows }, { title, lead, tokensCss }) {
  const th = head.map((name) => `<th scope="col">${escapeHtml(name)}</th>`).join('');
  const tr = rows
    .map((row) => `<tr>${row.map((cell, i) => (i === 0 ? `<th scope="row">${escapeHtml(cell)}</th>` : `<td>${escapeHtml(cell)}</td>`)).join('')}</tr>`)
    .join('\n');
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
${tokensCss}
body { margin: 0; padding: var(--space-5); background: var(--bg); color: var(--text); font-family: var(--font-sans); line-height: var(--leading); }
main { display: inline-block; padding: var(--space-4); border: var(--border); border-radius: var(--radius-xl); background: var(--panel); }
h1 { margin: 0 0 var(--space-1); font-size: var(--text-lg); }
p { margin: 0 0 var(--space-3); color: var(--muted); font-size: var(--text-sm); }
table { border-collapse: collapse; font-size: var(--text-sm); font-variant-numeric: tabular-nums; }
th, td { padding: var(--space-2) var(--space-3); border-bottom: var(--border); text-align: right; white-space: nowrap; }
thead th { color: var(--muted); font-weight: 600; text-align: right; vertical-align: bottom; white-space: normal; min-width: 4.5em; max-width: 8em; }
thead th:first-child, tbody th { text-align: left; }
tbody th { font-family: var(--font-mono); font-weight: 500; }
tbody tr:last-child th, tbody tr:last-child td { border-bottom: 0; }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(lead)}</p>
<table>
<thead><tr>${th}</tr></thead>
<tbody>
${tr}
</tbody>
</table>
</main>
</body>
</html>
`;
}
