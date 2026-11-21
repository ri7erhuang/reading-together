/* AI 问答：流式接收、增量累积到数据层、可中止 */
import { streamSSE } from '../../api.js';
import { toast, esc } from '../../ui.js';
import { state, hooks, noteById, upsertNote, notesOfPara } from './state.js';
import { PARA_LIMIT } from './render.js';

/** 流式过程中直接更新 DOM；数据层同步累积，重绘不会丢字 */
function paintStreamingText(n) {
  const card = document.querySelector('.note[data-id="' + n.id + '"]');
  if (!card) return;
  const ans = card.querySelector('.ans');
  if (!ans) return;
  if (ans.classList.contains('loading')) {
    ans.classList.remove('loading');
    ans.dataset.reset = '1';
    ans.textContent = '';
  }
  ans.textContent = n.answer || '';
}

function bindRetry(card, noteId) {
  const btn = card.querySelector('.retry');
  if (btn) btn.onclick = (ev) => { ev.stopPropagation(); retryAsk(noteId); };
}

export function startAsk(bookId, paraIdx, quote, question) {
  let noteId = null;
  const ctx = { abort: null };

  const { abort, promise } = streamSSE('/api/ai/ask',
    { bookId, paraIdx, quote, question },
    {
      onStart(note) {
        noteId = note.id;
        state.streaming.add(note.id);
        upsertNote(note);
        if (ctx.abort) state.aborters.set(note.id, ctx.abort);
        // 不强行展开整段批注（那会把正文顶走）；超限时提示用户手动展开
        if (notesOfPara(paraIdx).length > PARA_LIMIT) {
          toast('AI 批注已加在这一段末尾，点「展开」查看');
        } else {
          state.expandedPara.add(paraIdx);
        }
        hooks.repaintPara(paraIdx);
        setTimeout(() => hooks.scrollToNote(note.id), 80);
      },
      onDelta(text) {
        const n = noteById(noteId);
        if (!n) return;
        n.answer = (n.answer || '') + text; // 累积到数据层
        paintStreamingText(n);
      },
      onDone(note) {
        state.streaming.delete(note.id);
        state.aborters.delete(note.id);
        upsertNote(note);
        hooks.repaintPara(note.paraIdx);
        if (note.answer) {
          const card = document.querySelector('.note[data-id="' + note.id + '"]');
          if (card) repaintAnswerBlock(card, note);
        }
      },
      onError(msg) {
        state.streaming.delete(noteId);
        state.aborters.delete(noteId);
        const n = noteById(noteId);
        if (n) n.answer = null;
        const card = noteId ? document.querySelector('.note[data-id="' + noteId + '"]') : null;
        if (!card) { toast('AI 回答失败：' + msg, true); return; }
        const ans = card.querySelector('.ans');
        if (ans) {
          ans.className = 'ans';
          ans.dataset.reset = '';
          ans.innerHTML = '<span style="color:var(--accent)">回答失败：' + esc(msg) + '</span> ' +
            '<button class="retry tbtn" data-id="' + esc(noteId) + '">重试</button>';
          bindRetry(card, noteId);
        }
      }
    });

  ctx.abort = abort;
  if (noteId) state.aborters.set(noteId, abort);
  return promise.catch((e) => {
    // 主动中止（切书/离开）不算错误
    if (e && (e.name === 'AbortError' || /abort/i.test(e.message || ''))) return;
    if (!noteId) toast(e.message || 'AI 请求失败', true);
  });
}

export function retryAsk(noteId) {
  const n = noteById(noteId);
  if (!n) return;
  state.streaming.add(noteId);
  n.answer = null;
  hooks.repaintPara(n.paraIdx);

  const { abort, promise } = streamSSE('/api/ai/retry/' + noteId, {}, {
    onDelta(text) {
      const cur = noteById(noteId);
      if (!cur) return;
      cur.answer = (cur.answer || '') + text;
      paintStreamingText(cur);
    },
    onDone(note) {
      state.streaming.delete(note.id);
      state.aborters.delete(note.id);
      upsertNote(note);
      hooks.repaintPara(note.paraIdx);
    },
    onError(msg) {
      state.streaming.delete(noteId);
      state.aborters.delete(noteId);
      const cur = noteById(noteId);
      if (cur) cur.answer = null;
      hooks.repaintPara(n.paraIdx);
      toast('回答失败：' + msg, true);
    }
  });
  state.aborters.set(noteId, abort);
  return promise.catch(() => {});
}

/** 完成后把答案区替换成带折叠的版本 */
function repaintAnswerBlock(card, note) {
  const ans = card.querySelector('.ans');
  if (!ans) return;
  const text = String(note.answer || '');
  if (text.length <= 140) {
    ans.className = 'ans';
    ans.dataset.reset = '';
    ans.textContent = text;
  }
}
