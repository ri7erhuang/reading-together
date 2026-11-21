import { api, uploadBook } from '../api.js';
import { store, userName } from '../store.js';
import { esc, setLoading, toast } from '../ui.js';

function stat(n, label, cls) {
  return '<div class="stat"><div class="n ' + (cls || '') + '">' + n + '</div><div class="l">' + esc(label) + '</div></div>';
}

function card(b, i) {
  const c = b.counts || { total: 0, dad: 0, son: 0, ai: 0 };
  const pct = b.paraCount ? Math.min(100, Math.round(((b.progress ? b.progress.paraIdx + 1 : 0) / b.paraCount) * 100)) : 0;
  const meta = [b.author, b.tag].filter(Boolean).join(' · ');
  return '<a class="bcard" href="#/book/' + esc(b.id) + '">' +
    '<div class="no">' + String(i + 1).padStart(2, '0') + '</div>' +
    '<h3>' + esc(b.title) + '</h3>' +
    '<div class="tag">' + esc(meta || (b.sourceType === 'epub' ? 'EPUB 导入' : 'TXT 导入')) + '</div>' +
    '<div class="foot">' +
    (c.total ? '<span class="lit">已点亮</span>' : '<span>未开始</span>') +
    '<span class="dot dad"></span>' + c.dad + ' <span class="dot son"></span>' + c.son +
    (c.ai ? ' <span class="dot ai"></span>' + c.ai : '') +
    '<span style="margin-left:auto">' + (pct ? '读到 ' + pct + '%' : '共 ' + b.paraCount + ' 段') + '</span>' +
    '</div></a>';
}

export async function renderHome() {
  const data = await api('/api/bootstrap');
  store.users = data.users;
  store.books = data.books;
  store.totals = data.totals;
  store.llm = data.llm;
  store.bootstrapAt = Date.now();

  const t = store.totals;
  let h = '<div class="home-intro">' +
    esc(userName('dad')) + '和' + esc(userName('son')) + '<b>分开读同一本书</b>，各自在页边写批注，最后都挂回原文段落旁边——' +
    '左边是作者，右边是你们俩。<br>' +
    '划选原文里的任意一句，可以<b>写批注</b>、<b>查字词</b>、<b>问 AI</b>。' +
    '书架上除了内置的《朝花夕拾》，还能导入自己的 <b>txt / epub</b>。' +
    '</div>';

  h += '<div class="stats">' +
    stat(t.total, '总批注数', 'all') +
    stat(t.dad, userName('dad') + '的批注', 'dad') +
    stat(t.son, userName('son') + '的批注', 'son') +
    (t.ai ? stat(t.ai, 'AI 助读', 'ai') : '') +
    stat(store.books.length, '书架上的书') +
    '</div>';

  h += '<div class="book-grid">';
  store.books.forEach((b, i) => { h += card(b, i); });
  h += '<button class="bcard import-card" id="importCard">' +
    '<span class="big">＋</span><span>导入一本书</span>' +
    '<span class="sm">支持 txt / epub · 也可以直接把文件拖进来</span></button>';
  h += '</div>';

  const root = document.getElementById('home');
  root.innerHTML = h;

  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.txt,.epub,text/plain,application/epub+zip';
  input.multiple = true;
  input.style.display = 'none';
  document.body.appendChild(input);
  input.onchange = () => { importFiles([...input.files]); input.remove(); };

  document.getElementById('importCard').onclick = () => input.click();
}

export async function importFiles(files) {
  if (!files || !files.length) return;
  setLoading(true, '正在解析并导入…');
  try {
    let last = null;
    for (const f of files) {
      if (f.size > 120 * 1024 * 1024) { toast(f.name + ' 太大了（上限 120MB）', true); continue; }
      try {
        const out = await uploadBook(f);
        last = out;
        toast('《' + (out.title || f.name) + '》导入完成，共 ' + out.paraCount + ' 段');
      } catch (e) {
        toast(f.name + ' 导入失败：' + e.message, true);
      }
    }
    if (last) location.hash = '#/book/' + last.id;
    else await renderHome();
  } finally {
    setLoading(false);
  }
}

/* 整页拖拽导入 */
let dragDepth = 0;
export function bindHomeDnD() {
  window.addEventListener('dragover', (e) => {
    if (!document.getElementById('home').offsetParent) return;
    if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    document.getElementById('dropHint').classList.add('on');
  });
  window.addEventListener('dragleave', () => {
    dragDepth = 0;
    document.getElementById('dropHint').classList.remove('on');
  });
  window.addEventListener('drop', (e) => {
    if (!document.getElementById('home').offsetParent) return;
    e.preventDefault();
    document.getElementById('dropHint').classList.remove('on');
    if (e.dataTransfer && e.dataTransfer.files.length) importFiles([...e.dataTransfer.files]);
  });
}
