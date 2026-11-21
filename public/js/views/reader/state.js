/* 阅读器共享状态：各模块都从这里读，避免互相 import 形成环 */

export const state = {
  book: null,
  chapters: [],
  notes: [],
  paras: new Map(),      // paraIdx -> 段落对象（按章懒加载后填充）
  notesByPara: new Map(),
  streaming: new Set(),  // 正在流式回答的批注 id
  expandedPara: new Set(),
  expandedNote: new Set(),
  loadedChapters: new Set(),
  aborters: new Map(),   // 批注 id -> abort 函数
  activePara: 0
};

/** 供各模块注入的回调（避免循环依赖） */
export const hooks = {
  repaintPara: () => {},
  scrollToNote: () => {},
  onActivePara: () => {}
};

export function resetBookState() {
  state.book = null;
  state.chapters = [];
  state.notes = [];
  state.paras.clear();
  state.notesByPara.clear();
  state.streaming.clear();
  state.expandedPara.clear();
  state.expandedNote.clear();
  state.loadedChapters.clear();
  state.aborters.clear();
  state.activePara = 0;
}

/** 重新建立「段落 → 批注列表」索引 */
export function rebuildIndex() {
  const map = new Map();
  for (const n of state.notes) {
    if (!map.has(n.paraIdx)) map.set(n.paraIdx, []);
    map.get(n.paraIdx).push(n);
  }
  for (const list of map.values()) {
    list.sort((a, b) => String(a.time) < String(b.time) ? -1 : 1);
  }
  state.notesByPara = map;
}

export function notesOfPara(i) {
  return state.notesByPara.get(i) || [];
}

export function noteById(id) {
  return state.notes.find((n) => n.id === id) || null;
}

/** 把服务端返回的批注并入本地列表（同 id 覆盖） */
export function upsertNote(note) {
  const found = state.notes.find((n) => n.id === note.id);
  if (found) Object.assign(found, note);
  else state.notes.push({ replies: [], ...note });
  rebuildIndex();
  return found || note;
}

export function removeNoteLocal(id) {
  state.notes = state.notes.filter((n) => n.id !== id);
  rebuildIndex();
}

/** 切书/离开页面时中止所有进行中的流，并清掉「正在流式」标记 */
export function abortAll() {
  for (const abort of state.aborters.values()) {
    try { abort(); } catch {}
  }
  state.aborters.clear();
  state.streaming.clear();
}
