/* 阅读器编排：加载书 → 渲染章节骨架 → 按需懒加载段落 → 恢复进度 */
import { api } from '../api.js';
import { esc } from '../ui.js';
import { userName } from '../store.js';
import { state, hooks, resetBookState, rebuildIndex, abortAll } from './reader/state.js';
import { chapterBodyHtml } from './reader/render.js';
import { bindChapter, installReaderHooks } from './reader/events.js';
import { resetProgress, flushProgress, setActivePara, bindPageLifecycle } from './reader/progress.js';
import { initSelectionBar, resetSelectionUi } from './reader/actions.js';

let chapterIO = null;
let currentBookId = null;
let pendingLoads = new Map();
let progress = null;

installReaderHooks();
initSelectionBar();
bindPageLifecycle();

/* ---------------- 入口 ---------------- */

export async function renderReader(bookId, opts = {}) {
  flushProgress();
  abortAll();
  resetSelectionUi();

  const meta = await api('/api/books/' + encodeURIComponent(bookId));
  if (currentBookId !== bookId) {
    resetBookState();
    currentBookId = bookId;
  }
  state.book = meta.book;
  state.chapters = meta.chapters || [];
  state.notes = (meta.notes || []).map((n) => ({ ...n, replies: n.replies || [] }));
  rebuildIndex();
  progress = meta.progress || null;

  paint();
  const startCh = chapterOfPara(progress && progress.paraIdx);
  await ensureChapter(startCh ?? (state.chapters[0] ? state.chapters[0].idx : 0));
  if (opts.restoreProgress !== false) await restoreProgress();
}

/* ---------------- 骨架 ---------------- */

function paint() {
  const counts = { dad: 0, son: 0, ai: 0 };
  for (const n of state.notes) if (counts[n.author] != null) counts[n.author]++;
  const multi = state.chapters.length > 1;

  let h = '<button class="back" id="backHome">← 书架</button>';
  h += '<div class="essay-head"><h2>' + esc(state.book.title) + '</h2><div class="meta">' +
    (state.book.author ? '<span>' + esc(state.book.author) + '</span>' : '') +
    '<span class="cnt"><b class="dad">' + esc(userName('dad')) + ' ' + counts.dad + '</b> · ' +
    '<b class="son">' + esc(userName('son')) + ' ' + counts.son + '</b>' +
    (counts.ai ? ' · <b style="color:#534ab7">AI ' + counts.ai + '</b>' : '') + '</span>' +
    (multi ? '<select id="tocSel">' + state.chapters.map((c) =>
      '<option value="' + c.idx + '">' + esc(c.title) + '</option>').join('') + '</select>' : '') +
    '<span>划选句子写批注 · 段落旁「＋」可整段批注</span>' +
    '</div></div><div id="bookBody">';

  for (const ch of state.chapters) {
    h += '<section class="chapter" id="ch-' + ch.idx + '" data-ch="' + ch.idx + '">';
    if (multi) h += '<div class="chapter-sep"><span>' + esc(ch.title) + '</span></div>';
    h += '<div class="chapter-body" data-ch="' + ch.idx + '"></div></section>';
  }
  h += '</div>';

  const root = document.getElementById('reader');
  root.innerHTML = h;
  document.getElementById('backHome').onclick = () => { flushProgress(); location.hash = ''; };

  const toc = document.getElementById('tocSel');
  if (toc) {
    toc.onchange = async () => {
      const idx = Number(toc.value);
      await ensureChapter(idx);
      const sec = document.getElementById('ch-' + idx);
      if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
  }

  setupChapterObserver();
  resetProgress();
  hooks.onActivePara = syncToc;
}

/* ---------------- 懒加载 ---------------- */

function setupChapterObserver() {
  if (chapterIO) chapterIO.disconnect();
  chapterIO = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) ensureChapter(Number(e.target.dataset.ch));
    }
  }, { rootMargin: '1200px 0px' });
  document.querySelectorAll('.chapter').forEach((sec) => chapterIO.observe(sec));
}

function ensureChapter(idx) {
  if (idx == null || Number.isNaN(idx)) return Promise.resolve();
  if (state.loadedChapters.has(idx)) return Promise.resolve();
  if (pendingLoads.has(idx)) return pendingLoads.get(idx);

  const body = document.querySelector('.chapter-body[data-ch="' + idx + '"]');
  const ch = state.chapters.find((c) => c.idx === idx);
  if (!body || !ch) return Promise.resolve();

  body.innerHTML = '<div class="chapter-loading">正在加载…</div>';
  const task = api('/api/books/' + encodeURIComponent(state.book.id) + '/chapters/' + idx + '/paras')
    .then((d) => {
      for (const p of d.paras) state.paras.set(p.i, p);
      state.loadedChapters.add(idx);
      body.innerHTML = chapterBodyHtml(ch, state.paras);
      bindChapter(body);
    })
    .catch((e) => {
      body.innerHTML = '<div class="chapter-loading">这一章加载失败：' + esc(e.message) +
        ' <button class="retry-load">重试</button></div>';
      const btn = body.querySelector('.retry-load');
      if (btn) btn.onclick = () => { btn.disabled = true; ensureChapter(idx); };
    })
    .finally(() => pendingLoads.delete(idx));

  pendingLoads.set(idx, task);
  return task;
}

/* ---------------- 进度 ---------------- */

function chapterOfPara(paraIdx) {
  if (paraIdx == null) return null;
  const ch = state.chapters.find((c) => paraIdx >= c.paraStart && paraIdx < c.paraStart + c.paraCount);
  return ch ? ch.idx : null;
}

async function restoreProgress() {
  if (!progress || !progress.paraIdx) return;
  const row = document.querySelector('.para-row[data-i="' + progress.paraIdx + '"]');
  if (!row) return;
  await new Promise((r) => requestAnimationFrame(r));
  row.scrollIntoView({ block: 'start' });
  setActivePara(progress.paraIdx);
}

/** 目录跟着阅读位置走 */
function syncToc(paraIdx) {
  const sel = document.getElementById('tocSel');
  if (!sel) return;
  const idx = chapterOfPara(paraIdx);
  if (idx != null && String(sel.value) !== String(idx)) sel.value = String(idx);
}
