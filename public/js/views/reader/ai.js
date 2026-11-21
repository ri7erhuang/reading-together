/* AI 问答：流式接收、增量累积到数据层、可中止、失败可重试 */
import { streamSSE } from '../../api.js';
import { toast } from '../../ui.js';
import { state, hooks, noteById, notesOfPara, upsertNote } from './state.js';
import { PARA_LIMIT } from './render.js';

const isAbort = (e) => !!e && (e.name === 'AbortError' || /abort/i.test(e.message || ''));

/** 流式过程中只更新答案区，避免整卡重绘打断视觉连续 */
function paintStreamingText(n) {
  const card = document.querySelector('.note[data-id="' + n.id + '"]');
  if (!card) return;
  const ans = card.querySelector('.ans');
  if (!ans) return;
  if (ans.classList.contains('loading')) {
    ans.classList.remove('loading');
    ans.textContent = '';
  }
  ans.textContent = n.answer || '';
}

/** 只把 answer 合并进本地状态（不覆盖 replies，否则流式期间新增的回复会被抹掉） */
function mergeAnswer(id, answer) {
  const local = noteById(id);
  if (!local) return null;
  local.answer = answer;
  return local;
}

function failNote(noteId, msg) {
  state.streaming.delete(noteId);
  state.aborters.delete(noteId);
  const n = noteById(noteId);
  if (n) {
    n.answer = null;
    hooks.repaintPara(n.paraIdx);   // answerBlock 会渲染「上次没答完 + 重试」
  }
  toast('回答失败：' + msg, true);
}

export function startAsk(bookId, paraIdx, quote, question) {
  let noteId = null;
  const tempKey = 'tmp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);

  const { abort, promise } = streamSSE('/api/ai/ask',
    { bookId, paraIdx, quote, question },
    {
      onStart(note) {
        // 已经切书：这条流不该再往新书里写
        if (!state.book || state.book.id !== bookId) { abort(); return; }
        noteId = note.id;
        state.aborters.delete(tempKey);
        state.aborters.set(note.id, abort);
        state.streaming.add(note.id);
        upsertNote(note);
        if (notesOfPara(paraIdx).length > PARA_LIMIT) {
          toast('AI 批注已加在这一段末尾，点「展开」查看');
        } else {
          state.expandedPara.add(paraIdx);
        }
        hooks.repaintPara(paraIdx);
        setTimeout(() => hooks.scrollToNote(note.id), 80);
      },
      onDelta(text) {
        if (!noteId) return;
        const n = noteById(noteId);
        if (!n) return;
        n.answer = (n.answer || '') + text;   // 先落数据，再刷 DOM
        paintStreamingText(n);
      },
      onDone(note) {
        state.streaming.delete(note.id);
        state.aborters.delete(note.id);
        const local = mergeAnswer(note.id, note.answer);
        if (!local) return;                   // 中途被删了，不要再画回来
        hooks.repaintPara(local.paraIdx);
      },
      onError(msg) {
        if (!noteId) { toast('AI 请求失败：' + msg, true); return; }
        failNote(noteId, msg);
      }
    });

  // start 之前就登记，保证「发出后立刻切书」也能被 abortAll 覆盖
  state.aborters.set(tempKey, abort);

  return promise.catch((e) => {
    state.aborters.delete(tempKey);
    if (isAbort(e)) return;
    if (noteId) failNote(noteId, e.message || '连接中断');
    else toast(e.message || 'AI 请求失败', true);
  });
}

export function retryAsk(noteId) {
  const n = noteById(noteId);
  if (!n) return;
  const before = n.answer;          // 失败时恢复，不让旧答案被清空
  state.streaming.add(noteId);
  n.answer = null;
  hooks.repaintPara(n.paraIdx);

  const { abort, promise } = streamSSE('/api/ai/retry/' + encodeURIComponent(noteId), {}, {
    onDelta(text) {
      const cur = noteById(noteId);
      if (!cur) return;
      cur.answer = (cur.answer || '') + text;
      paintStreamingText(cur);
    },
    onDone(note) {
      state.streaming.delete(note.id);
      state.aborters.delete(note.id);
      const local = mergeAnswer(note.id, note.answer);
      if (local) hooks.repaintPara(local.paraIdx);
    },
    onError(msg) {
      const cur = noteById(noteId);
      if (cur) cur.answer = before;
      state.streaming.delete(noteId);
      state.aborters.delete(noteId);
      hooks.repaintPara(n.paraIdx);
      toast('回答失败：' + msg, true);
    }
  });

  state.aborters.set(noteId, abort);
  return promise.catch((e) => {
    if (isAbort(e)) return;
    const cur = noteById(noteId);
    if (cur) cur.answer = before;
    state.streaming.delete(noteId);
    state.aborters.delete(noteId);
    hooks.repaintPara(n.paraIdx);
    toast(e.message || '重试失败', true);
  });
}
