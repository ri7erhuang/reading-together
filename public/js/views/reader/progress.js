/* 阅读进度：IntersectionObserver 记录当前位置，节流保存，切书前 flush */
import { api, session } from '../../api.js';
import { state, hooks } from './state.js';

let observer = null;
let saveTimer = 0;
let pending = false;

function ensureObserver() {
  if (observer) return observer;
  observer = new IntersectionObserver((entries) => {
    let best = null;
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const i = Number(e.target.dataset.i);
      const top = e.boundingClientRect.top;
      if (best === null || top < best.top) best = { i, top };
    }
    if (best && best.i !== state.activePara) {
      state.activePara = best.i;
      pending = true;
      hooks.onActivePara(best.i);
      scheduleSave();
    }
  }, { rootMargin: '-80px 0px -60% 0px', threshold: 0 });
  return observer;
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveProgress, 1500);
}

export function observeParaRow(row) {
  ensureObserver().observe(row);
}

export function resetProgress() {
  if (observer) observer.disconnect();
  ensureObserver();
  clearTimeout(saveTimer);
  pending = false;
  state.activePara = 0;
}

export function setActivePara(i, { silent = true } = {}) {
  state.activePara = i;
  hooks.onActivePara(i);
  pending = !silent;
  if (!silent) scheduleSave();
}

/** 立即写入（切书、页面隐藏时用） */
export function flushProgress() {
  clearTimeout(saveTimer);
  if (!pending || !state.book) return;
  saveProgress();
}

function saveProgress() {
  if (!state.book) return;
  const bookId = state.book.id;
  const paraIdx = state.activePara;
  pending = false;
  api('/api/progress', { method: 'POST', body: { bookId, paraIdx } }).catch(() => {});
}

/** 页面关闭/切到后台时兜底保存（keepalive 保证请求能发出去） */
export function bindPageLifecycle() {
  const bye = () => {
    if (!pending || !state.book) return;
    const url = '/api/progress';
    const body = JSON.stringify({ bookId: state.book.id, paraIdx: state.activePara });
    try {
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User': session.userId },
        body,
        keepalive: true
      });
    } catch {}
  };
  window.addEventListener('pagehide', bye);
  window.addEventListener('beforeunload', bye);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushProgress();
  });
}
