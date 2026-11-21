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
let renderSeq = 0;                       // 用于丢弃过期的导航/加载结果
let pendingLoads = new Map();            // "bookId:chapterIdx" -> Promise
let progress = null;

installReaderHooks();
initSelectionBar();
bindPageLifecycle();

/* ---------------- 入口 ---------------- */

export async function renderReader(bookId, opts = {}) {
  const seq = ++renderSeq;

  flushProgress();
  abortAll();
  resetSelectionUi();

  const meta = await api('/api/books/' + encodeURIComponent(bookId));
  if (seq !== renderSeq) return;         // 期间已经切到别的书

  // 每次进入都重建：同一本书二次进入时必须清空，否则骨架是新的、缓存却认为已加载
  resetBookState();
  pendingLoads.clear();
  currentBookId = bookId;

  state.book = meta.book;
  state.chapters = meta.chapters || [];
  state.notes = (meta.notes || []).map((n) => ({ ...n, replies: n.replies || [] }));
  rebuildIndex();
  progress = meta.progress || null;

  paint();
  const startCh = chapterOfPara(progress && progress.paraIdx);
  await ensureChapter(startCh ?? (state.chapters[0] ? state.chapters[0].idx : 0), seq);
  if (seq !== renderSeq) return;
  if (opts.restoreProgress !== false) await restoreProgress(seq);
}

/** 离开阅读页时调用：中止所有流并保存进度 */
export function leaveReader() {
  abortAll();
  flushProgress();
  resetSelectionUi();
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
  document.getElementById('backHome').onclick = () => { location.hash = ''; };

  const toc = document.getElementById('tocSel');
  if (toc) {
    toc.onchange = async () => {
      const idx = Number(toc.value);
      await ensureChapter(idx, renderSeq);
      const sec = document.getElementById('ch-' + idx);
      if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
  }

  setupChapterObserver();
  resetProgress();
  hooks.onActivePara = syncToc;
  hooks.scrollToNote = (id) => {
    const card = document.querySelector('.note[data-id="' + id + '"]');
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
}

/* ---------------- 懒加载 ---------------- */

function setupChapterObserver() {
  if (chapterIO) chapterIO.disconnect();
  chapterIO = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) ensureChapter(Number(e.target.dataset.ch), renderSeq);
    }
  }, { rootMargin: '400px 0px' });   // 未加载章节有占位高度，提前量不用给太大
  document.querySelectorAll('.chapter').forEach((sec) => chapterIO.observe(sec));
}

function ensureChapter(idx, seq) {
  if (idx == null || Number.isNaN(idx)) return Promise.resolve();
  const bookId = state.book && state.book.id;
  if (!bookId) return Promise.resolve();
  if (state.loadedChapters.has(idx)) return Promise.resolve();

  const key = bookId + ':' + idx;
  if (pendingLoads.has(key)) return pendingLoads.get(key);

  const body = document.querySelector('.chapter-body[data-ch="' + idx + '"]');
  const ch = state.chapters.find((c) => c.idx === idx);
  if (!body || !ch) return Promise.resolve();

  body.innerHTML = '<div class="chapter-loading">正在加载…</div>';
  const task = api('/api/books/' + encodeURIComponent(bookId) + '/chapters/' + idx + '/paras')
    .then((d) => {
      // 响应回来时可能已经切书，直接丢弃
      if (seq !== renderSeq || !state.book || state.book.id !== bookId) return;
      if (!document.contains(body)) return;
      for (const p of d.paras) state.paras.set(p.i, p);
      state.loadedChapters.add(idx);
      body.classList.add('loaded');
      body.innerHTML = chapterBodyHtml(ch, state.paras);
      bindChapter(body);
    })
    .catch((e) => {
      if (seq !== renderSeq) return;
      if (!document.contains(body)) return;
      body.innerHTML = '<div class="chapter-loading">这一章加载失败：' + esc(e.message) +
        ' <button class="retry-load">重试</button></div>';
      const btn = body.querySelector('.retry-load');
      if (btn) btn.onclick = () => { btn.disabled = true; ensureChapter(idx, renderSeq); };
    })
    .finally(() => pendingLoads.delete(key));

  pendingLoads.set(key, task);
  return task;
}

/* ---------------- 进度 ---------------- */

function chapterOfPara(paraIdx) {
  if (paraIdx == null) return null;
  const ch = state.chapters.find((c) => paraIdx >= c.paraStart && paraIdx < c.paraStart + c.paraCount);
  return ch ? ch.idx : null;
}

/**
 * 恢复进度：必须先把目标章之前的章节都加载出来，否则前面的占位高度会让定位落空。
 * 加载完再滚动一次，防止后到的内容把目标行顶走。
 */
async function restoreProgress(seq) {
  if (!progress || !progress.paraIdx) return;
  const target = chapterOfPara(progress.paraIdx);
  if (target == null) return;
  const targetPos = state.chapters.findIndex((c) => c.idx === target);
  if (targetPos < 0) return;

  for (let i = 0; i <= targetPos; i++) {
    if (seq !== renderSeq) return;
    await ensureChapter(state.chapters[i].idx, seq);
  }

  const row = document.querySelector('.para-row[data-i="' + progress.paraIdx + '"]');
  if (!row) return;
  await new Promise((r) => requestAnimationFrame(r));
  row.scrollIntoView({ block: 'start' });
  setActivePara(progress.paraIdx);
  setTimeout(() => {
    if (seq === renderSeq && document.contains(row)) row.scrollIntoView({ block: 'start' });
  }, 300);
}

/** 目录跟着阅读位置走 */
function syncToc(paraIdx) {
  const sel = document.getElementById('tocSel');
  if (!sel) return;
  const idx = chapterOfPara(paraIdx);
  if (idx != null && String(sel.value) !== String(idx)) sel.value = String(idx);
}
