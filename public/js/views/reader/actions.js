/* 交互动作：发批注、查字词、问 AI，以及划选工具条 */
import { api, session } from '../../api.js';
import { esc, openModal, closeModal, toast, TYPES, TYPE_DESC, debounce } from '../../ui.js';
import { userName } from '../../store.js';
import { state, hooks, upsertNote, noteById, notesOfPara } from './state.js';
import { PARA_LIMIT } from './render.js';
import { startAsk } from './ai.js';

/* ---------------- 发批注 ---------------- */

export function openAdd(paraIdx, quote) {
  const para = state.paras.get(paraIdx);
  if (!para || !state.book) return;
  let author = session.userId;
  let type = 'kaodian';

  const box = openModal(
    '<h3>发一条批注</h3><div class="mh">《' + esc(state.book.title) + '》 · ' +
    (quote ? '针对<b>你选中的这句话</b>' : '针对这一段') + '</div>' +
    '<label>谁在说话</label><div class="seg">' +
    '<button id="mDad">' + esc(userName('dad')) + '</button>' +
    '<button id="mSon">' + esc(userName('son')) + '</button></div>' +
    '<label>批注类型</label><div class="chips">' +
    Object.keys(TYPES).filter((t) => t !== 'aiask').map((t) =>
      '<button data-t="' + t + '"' + (t === type ? ' class="on"' : '') + '>' + TYPES[t] + ' · ' + TYPE_DESC[t] + '</button>').join('') +
    '</div>' +
    '<label>针对的原文（摘录，可留空）</label>' +
    '<input type="text" id="mQuote" value="' + esc(quote || '') + '" placeholder="留空表示针对整段">' +
    '<label>批注内容</label><textarea id="mText" placeholder="写点什么……吐槽也行，提问也行，发现考点更行"></textarea>' +
    '<div class="btns"><button class="ok" id="mOk">挂到这一段</button><button class="cc" id="mCc">取消</button></div>'
  );

  const pick = (a) => {
    author = a;
    box.querySelector('#mDad').className = a === 'dad' ? 'sel-dad' : '';
    box.querySelector('#mSon').className = a === 'son' ? 'sel-son' : '';
  };
  pick(author);
  box.querySelector('#mDad').onclick = () => pick('dad');
  box.querySelector('#mSon').onclick = () => pick('son');
  box.querySelectorAll('.chips button').forEach((b) => {
    b.onclick = () => {
      box.querySelectorAll('.chips button').forEach((x) => { x.className = ''; });
      b.className = 'on';
      type = b.dataset.t;
    };
  });
  box.querySelector('#mCc').onclick = closeModal;
  box.querySelector('#mOk').onclick = async () => {
    const text = box.querySelector('#mText').value.trim();
    if (!text) { box.querySelector('#mText').focus(); return; }
    try {
      const out = await api('/api/notes', {
        method: 'POST',
        body: {
          bookId: state.book.id, paraIdx, author, type,
          quote: box.querySelector('#mQuote').value.trim(), text
        }
      });
      upsertNote({ ...out.note, replies: [] });
      // 不超过折叠阈值时直接展开，让新批注可见；超限则提示手动展开
      if (notesOfPara(paraIdx).length <= PARA_LIMIT) state.expandedPara.add(paraIdx);
      closeModal();
      hooks.repaintPara(paraIdx);
      const el = document.getElementById('p-' + paraIdx);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.remove('flash');
        void el.offsetWidth;
        el.classList.add('flash');
      }
      if (out.warning) toast(out.warning, true);
      else if (notesOfPara(paraIdx).length > PARA_LIMIT) toast('批注已保存，这一段还有更多条，点「展开」查看');
      else toast('批注已挂上');
    } catch (e) { toast(e.message, true); }
  };
  setTimeout(() => box.querySelector('#mText').focus(), 50);
}

/* ---------------- 查字词 ---------------- */

export async function openDict(term) {
  const box = openModal('<h3>查字词</h3><div class="mh">「' + esc(String(term).slice(0, 30)) + '」</div>' +
    '<div class="dictmiss">查询中…</div>' +
    '<div class="btns"><button class="ok" id="dOk">关闭</button></div>');
  box.querySelector('#dOk').onclick = closeModal;

  const fail = (msg) => {
    box.innerHTML = '<h3>查字词</h3><div class="dictmiss">' + msg + '</div>' +
      '<div class="btns"><button class="ok" id="dOk">关闭</button></div>';
    box.querySelector('#dOk').onclick = closeModal;
  };

  try {
    const r = await api('/api/dict?w=' + encodeURIComponent(term));
    if (!r || r.found === false) {
      const text = String(term);
      box.innerHTML = '<h3>查字词</h3>' +
        '<div class="dictword">' + esc(text.length > 12 ? text.slice(0, 12) + '…' : text) + '</div>' +
        '<div class="dictmiss">这一条暂未收录。<br><br>' +
        (r && r.source === 'none'
          ? '后台还没有配置大模型 key，所以只能查内置词表。配置之后任意字词都能查。'
          : '换个词试试？') + '</div>' +
        '<div class="btns"><button class="ok" id="dOk">知道了</button></div>';
      box.querySelector('#dOk').onclick = closeModal;
      return;
    }
    box.innerHTML = '<h3>查字词</h3>' +
      '<div class="dictword">' + esc(r.word) + '</div>' +
      '<div class="dictpy">' + esc(r.pinyin || '') + '</div>' +
      '<div class="dictdef">' + esc(r.def || '') + '</div>' +
      (r.exact === false ? '<div class="hint">你划选的文字里含有「' + esc(r.word) + '」，以上是它的释义</div>' : '') +
      '<div class="hint">' + (r.source === 'ai' ? '由后台模型生成 · 已缓存' : '内置词表 · 未收录的词会交给模型') + '</div>' +
      '<div class="btns"><button class="ok" id="dOk">知道了</button></div>';
    box.querySelector('#dOk').onclick = closeModal;
  } catch (e) {
    fail('查询失败：' + esc(e.message));
  }
}

/* ---------------- 问 AI ---------------- */

export function openAsk(paraIdx, quote) {
  if (!state.book) return;
  const box = openModal(
    '<h3>问 AI</h3><div class="mh">《' + esc(state.book.title) + '》 · 针对你划选的这句话</div>' +
    '<div class="askquote">「' + esc(quote) + '」</div>' +
    '<div class="askbox"><textarea id="askTa" placeholder="问点什么，比如：这句话有什么言外之意？作者为什么这样写？"></textarea>' +
    '<div class="askfoot"><div class="hint">回车发送 · Shift + 回车换行</div>' +
    '<button class="send" id="askSend">发送</button></div></div>'
  );
  const send = () => {
    const ta = box.querySelector('#askTa');
    const q = ta.value.trim();
    if (!q) { ta.focus(); return; }
    closeModal();
    startAsk(state.book.id, paraIdx, quote, q);
  };
  box.querySelector('#askSend').onclick = send;
  box.querySelector('#askTa').onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };
  setTimeout(() => box.querySelector('#askTa').focus(), 60);
}

/* ---------------- 划选工具条 ---------------- */

let pendingSel = null;

function hideSelBar() {
  const bar = document.getElementById('selBar');
  if (bar) bar.style.display = 'none';
  pendingSel = null;
}

function readSelection() {
  if (!state.book) return null;
  const overlay = document.getElementById('overlay');
  if (overlay && !overlay.classList.contains('hidden')) return null;
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (range.collapsed) return null;

  const nodeOf = (n) => (n.nodeType === 1 ? n : n.parentElement);
  const startPara = nodeOf(range.startContainer)?.closest('.para');
  const endPara = nodeOf(range.endContainer)?.closest('.para');
  // 只接受同一段内的选区：跨段无法定位成一条批注
  if (!startPara || !endPara || startPara !== endPara) return null;
  if (!/^p-\d+$/.test(startPara.id || '')) return null;

  // 克隆选区并移除编号小签，保证摘录能和原文逐字对上
  let text = '';
  try {
    const frag = range.cloneContents();
    if (frag.querySelectorAll) frag.querySelectorAll('.mk').forEach((n) => n.remove());
    text = (frag.textContent || '').replace(/[ \t]+/g, ' ').trim();
  } catch {
    text = String(sel).trim();
  }
  if (!text || text.length < 2) return null;

  const paraIdx = Number(startPara.id.slice(2));
  if (!state.paras.has(paraIdx)) return null;
  return { text, paraIdx, rect: range.getBoundingClientRect() };
}

function showSelBar() {
  const sel = readSelection();
  const bar = document.getElementById('selBar');
  if (!bar) return;
  if (!sel) { bar.style.display = 'none'; pendingSel = null; return; }
  pendingSel = sel;
  bar.style.display = 'flex';
  bar.style.left = Math.max(90, sel.rect.left + sel.rect.width / 2) + 'px';
  bar.style.top = Math.max(58, sel.rect.top) + 'px';
}

let inited = false;

export function initSelectionBar() {
  if (inited) return;
  inited = true;

  document.addEventListener('mouseup', (e) => {
    if (e.target && e.target.closest && e.target.closest('#selBar,.modal')) return;
    setTimeout(showSelBar, 10);
  });
  document.addEventListener('selectionchange', debounce(showSelBar, 380));
  window.addEventListener('scroll', () => { if (pendingSel) hideSelBar(); }, { passive: true });
  window.addEventListener('resize', () => { if (pendingSel) hideSelBar(); });

  const bar = document.getElementById('selBar');
  if (!bar) return;
  bar.addEventListener('pointerdown', (e) => e.preventDefault());
  bar.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => {
      if (!pendingSel) return;
      const ps = pendingSel;
      hideSelBar();
      const s = window.getSelection();
      if (s) s.removeAllRanges();
      if (b.dataset.act === 'note') openAdd(ps.paraIdx, ps.text);
      else if (b.dataset.act === 'dict') openDict(ps.text);
      else openAsk(ps.paraIdx, ps.text);
    });
  });
}

/** 切书时收起工具条 */
export function resetSelectionUi() {
  hideSelBar();
}
