import { api, session, streamSSE } from '../api.js';
import { store, userName } from '../store.js';
import { esc, fmtTime, TYPES, TYPE_DESC, openModal, closeModal, toast, findQuote, debounce } from '../ui.js';

let cur = null;
const PARA_LIMIT = 2;
const CLIP = 140;
let EXPANDED_PARA = new Set();
let EXPANDED_NOTE = new Set();
const streaming = new Set();

/* ================= 入口 ================= */

export async function renderReader(bookId, opts = {}) {
  const data = await api('/api/books/' + encodeURIComponent(bookId));
  if (!cur || cur.book.id !== bookId) {
    EXPANDED_PARA = new Set();
    EXPANDED_NOTE = new Set();
  }
  data.notes.forEach((n) => { if (!n.replies) n.replies = []; });
  cur = data;
  paint({ restoreProgress: opts.restoreProgress !== false });
}

function paint(opts = {}) {
  if (!cur) return;
  const y = opts.keepScroll ? window.scrollY : 0;
  const book = cur.book;
  const notes = cur.notes;
  const counts = {
    dad: notes.filter((n) => n.author === 'dad').length,
    son: notes.filter((n) => n.author === 'son').length,
    ai: notes.filter((n) => n.author === 'ai').length
  };

  let h = '<button class="back" id="backHome">← 书架</button>';
  h += '<div class="essay-head"><h2>' + esc(book.title) + '</h2><div class="meta">' +
    (book.author ? '<span>' + esc(book.author) + '</span>' : '') +
    '<span class="cnt"><b class="dad">' + esc(userName('dad')) + ' ' + counts.dad + '</b> · ' +
    '<b class="son">' + esc(userName('son')) + ' ' + counts.son + '</b>' +
    (counts.ai ? ' · <b style="color:#534ab7">AI ' + counts.ai + '</b>' : '') + '</span>' +
    (cur.chapters.length > 1
      ? '<select id="tocSel">' + cur.chapters.map((c) =>
        '<option value="' + c.idx + '">' + esc(c.title) + '</option>').join('') + '</select>'
      : '') +
    '<span>划选句子写批注 · 段落旁「＋」可整段批注</span>' +
    '</div></div><div id="bookBody">';

  cur.chapters.forEach((ch) => {
    if (cur.chapters.length > 1) {
      h += '<div class="chapter-sep" id="ch-' + ch.idx + '" data-ch="' + ch.idx + '"><span>' +
        esc(ch.title) + '</span></div>';
    }
    for (let i = ch.paraStart; i < ch.paraStart + ch.paraCount; i++) {
      const p = cur.paras[i];
      if (!p) continue;
      const pn = notesOfPara(i);
      const openAll = EXPANDED_PARA.has(i);
      const shown = openAll ? pn : pn.slice(0, PARA_LIMIT);
      h += '<div class="para-row" data-i="' + i + '" data-ch="' + ch.idx + '">' +
        '<div class="para' + (p.kind === 'sign' ? ' sign' : '') + (p.text.includes('\n') ? ' pre' : '') +
        '" id="p-' + i + '"></div>' +
        '<div class="notes"><button class="add-para" data-i="' + i + '">＋ 批注</button>';
      shown.forEach((n) => {
        const loc = n.quote ? findQuote(p.text, n.quote) : null;
        h += noteHtml(n, loc ? pn.indexOf(n) + 1 : null);
      });
      if (pn.length > PARA_LIMIT) {
        h += '<button class="more-btn" data-pk="' + i + '">' +
          (openAll ? '收起' : '还有 ' + (pn.length - PARA_LIMIT) + ' 条批注 · 展开') + '</button>';
      }
      h += '</div></div>';
    }
  });
  h += '</div>';

  const root = document.getElementById('reader');
  root.innerHTML = h;

  cur.paras.forEach((p) => {
    const el = document.getElementById('p-' + p.i);
    if (el) el.innerHTML = paraHtml(p.text, notesOfPara(p.i));
  });

  document.getElementById('backHome').onclick = () => { location.hash = ''; };
  const toc = document.getElementById('tocSel');
  if (toc) {
    toc.onchange = () => {
      const el = document.getElementById('ch-' + toc.value);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
  }
  bindAddPara(root);
  bindNoteEvents(root);
  bindHoverLinks(root);

  if (opts.keepScroll) {
    window.scrollTo(0, y);
  } else if (opts.restoreProgress && cur.progress && cur.progress.paraIdx > 0) {
    const row = root.querySelector('.para-row[data-i="' + cur.progress.paraIdx + '"]');
    if (row) requestAnimationFrame(() => row.scrollIntoView({ block: 'start' }));
    else window.scrollTo(0, 0);
  } else {
    window.scrollTo(0, 0);
  }
}

function notesOfPara(i) {
  return cur.notes.filter((n) => n.paraIdx === i);
}

/* ================= 原文高亮 ================= */

function paraHtml(ptext, pn) {
  const ranges = [];
  pn.forEach((n, idx) => {
    if (!n.quote) return;
    const loc = findQuote(ptext, n.quote);
    if (!loc) return;
    const a = {};
    a[n.author] = 1;
    ranges.push({ s: loc.s, e: loc.e, a, i: idx, id: n.id, author: n.author });
  });
  ranges.sort((x, y) => x.s - y.s);
  const merged = [];
  ranges.forEach((r) => {
    const last = merged[merged.length - 1];
    if (last && r.s < last.e) {
      last.e = Math.max(last.e, r.e);
      for (const k in r.a) last.a[k] = 1;
      last.items.push(r);
    } else {
      merged.push({ s: r.s, e: r.e, a: r.a, items: [r] });
    }
  });

  let html = '';
  let cursor = 0;
  merged.forEach((m) => {
    const cls = (m.a.dad && m.a.son) ? 'hl-both' : (m.a.ai ? 'hl-ai' : (m.a.dad ? 'hl-dad' : 'hl-son'));
    const ids = m.items.map((x) => x.id).join(',');
    const marks = m.items.sort((x, y) => x.i - y.i).map((x) =>
      '<span class="mk ' + x.author + '" data-id="' + esc(x.id) + '">' + (x.i + 1) + '</span>').join('');
    html += esc(ptext.slice(cursor, m.s)) +
      '<span class="hl ' + cls + '" data-ids="' + esc(ids) + '">' + esc(ptext.slice(m.s, m.e)) + '</span>' + marks;
    cursor = m.e;
  });
  html += esc(ptext.slice(cursor));
  return html.replace(/\n/g, '<br>');
}

function repaintParaText(paraIdx) {
  if (!cur) return;
  const p = cur.paras[paraIdx];
  const el = document.getElementById('p-' + paraIdx);
  if (!p || !el) return;
  el.innerHTML = paraHtml(p.text, notesOfPara(paraIdx));
  bindHoverLinks(el.parentElement);
}

/* ================= 批注卡片 ================= */

function clipBlock(text, cls, id) {
  const long = String(text).length > CLIP;
  const open = EXPANDED_NOTE.has(id);
  const t = (long && !open) ? String(text).slice(0, CLIP) + '…' : String(text);
  let h = '<div class="' + cls + '">' + esc(t) + '</div>';
  if (long) {
    h += '<button class="showmore" data-id="' + esc(id) + '"' + (open ? ' data-collapse="1"' : '') + '>' +
      (open ? '收起' : '展开全文') + '</button>';
  }
  return h;
}

function answerBlock(n) {
  if (n.answer != null && String(n.answer).trim()) return clipBlock(n.answer, 'ans', n.id);
  if (streaming.has(n.id)) {
    return '<div class="ans loading">AI 正在读这句话<span class="dots"><i></i><i></i><i></i></span></div>';
  }
  return '<div class="ans"><span style="color:var(--ink3);font-size:.9em">上次没有答完</span> ' +
    '<button class="retry tbtn" data-id="' + esc(n.id) + '">重试</button></div>';
}

function noteHtml(n, no) {
  const rs = n.replies || [];
  const who = userName(n.author);
  let body = '';
  if (n.author === 'ai') {
    body = (n.quote ? '<div class="q">「' + esc(n.quote) + '」</div>' : '') +
      '<div class="ask">问：' + esc(n.text) + '</div>' + answerBlock(n);
  } else {
    body = (n.quote ? '<div class="q">「' + esc(n.quote) + '」</div>' : '') +
      clipBlock(n.text, 'tx', n.id) +
      (n.source && n.source !== '网页录入' ? '<div class="src">来自：' + esc(n.source) + '</div>' : '');
  }

  let h = '<div class="note ' + n.author + '" data-id="' + esc(n.id) + '" data-para="' + n.paraIdx + '" title="点击定位到原文">' +
    '<div class="nh">' + (no ? '<span class="nnum ' + n.author + '">' + no + '</span>' : '') +
    '<span class="who">' + esc(who) + '</span>' +
    '<span class="badge ' + n.type + '">' + (TYPES[n.type] || n.type) + '</span>' +
    '<span class="when">' + fmtTime(n.time) + '</span></div>' + body;

  if (rs.length) {
    h += '<div class="replies">';
    rs.forEach((r) => {
      h += '<div class="reply ' + r.author + '"><b>' + esc(userName(r.author)) + '</b>：' + esc(r.text) +
        '<span class="rt">' + fmtTime(r.time) + '</span>' +
        '<button class="rdel" data-rid="' + esc(r.id) + '">删</button></div>';
    });
    h += '</div>';
  }

  h += '<div class="nfoot"><button class="reply-btn">' + (rs.length ? '继续回复' : '回复') + '</button>' +
    '<button class="del" title="删除这条批注">删</button></div>' +
    '<div class="reply-box"><div class="who"><span>回复人</span>' +
    '<button data-a="dad">' + esc(userName('dad')) + '</button>' +
    '<button data-a="son">' + esc(userName('son')) + '</button></div>' +
    '<textarea placeholder="接着这句话说点什么……"></textarea>' +
    '<div class="rrow"><button class="cn">取消</button><button class="send">发送</button></div></div></div>';
  return h;
}

/* ================= 事件绑定 ================= */

function bindAddPara(root) {
  root.querySelectorAll('.add-para').forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); openAdd(Number(b.dataset.i), ''); };
  });
}

function bindNoteEvents(root) {
  root.querySelectorAll('.note .del').forEach((b) => {
    b.onclick = async (ev) => {
      ev.stopPropagation();
      const id = b.closest('.note').dataset.id;
      if (!confirm('确定删除这条批注吗？')) return;
      try {
        await api('/api/notes/' + id, { method: 'DELETE' });
        cur.notes = cur.notes.filter((n) => n.id !== id);
        paint({ keepScroll: true });
        toast('已删除');
      } catch (e) { toast(e.message, true); }
    };
  });

  root.querySelectorAll('.more-btn').forEach((b) => {
    b.onclick = (ev) => {
      ev.stopPropagation();
      const i = Number(b.dataset.pk);
      if (EXPANDED_PARA.has(i)) EXPANDED_PARA.delete(i); else EXPANDED_PARA.add(i);
      paint({ keepScroll: true });
    };
  });

  root.querySelectorAll('.showmore').forEach((b) => {
    b.onclick = (ev) => {
      ev.stopPropagation();
      const id = b.dataset.id;
      if (b.dataset.collapse) EXPANDED_NOTE.delete(id); else EXPANDED_NOTE.add(id);
      paint({ keepScroll: true });
    };
  });

  root.querySelectorAll('.retry').forEach((b) => {
    b.onclick = (ev) => { ev.stopPropagation(); retryAI(b.dataset.id); };
  });

  root.querySelectorAll('.note').forEach((card) => {
    card.onclick = (ev) => {
      if (ev.target.closest('.reply-box,.replies,.reply-btn,.rdel,.del,.showmore,.retry')) return;
      const i = Number(card.dataset.para);
      const el = document.getElementById('p-' + i);
      if (!el) return;
      const hl = el.querySelector('.hl');
      (hl || el).scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.remove('flash');
      void el.offsetWidth;
      el.classList.add('flash');
    };

    const nid = card.dataset.id;
    const note = cur.notes.find((x) => x.id === nid);
    const box = card.querySelector('.reply-box');
    const ta = card.querySelector('.reply-box textarea');
    let pick = session.userId;
    const paintWho = () => {
      card.querySelectorAll('.who button').forEach((b) => {
        b.className = (b.dataset.a === pick) ? ('on-' + pick) : '';
      });
    };
    paintWho();
    card.querySelectorAll('.who button').forEach((b) => {
      b.onclick = (ev) => { ev.stopPropagation(); pick = b.dataset.a; paintWho(); };
    });
    card.querySelector('.reply-btn').onclick = (ev) => {
      ev.stopPropagation();
      const open = box.classList.toggle('open');
      if (open) ta.focus();
    };
    card.querySelector('.reply-box .cn').onclick = (ev) => {
      ev.stopPropagation(); box.classList.remove('open'); ta.value = '';
    };
    card.querySelector('.reply-box .send').onclick = async (ev) => {
      ev.stopPropagation();
      const t = ta.value.trim();
      if (!t) { ta.focus(); return; }
      try {
        const out = await api('/api/notes/' + nid + '/replies', { method: 'POST', body: { text: t, author: pick } });
        if (note) { note.replies = note.replies || []; note.replies.push(out.reply); }
        paint({ keepScroll: true });
      } catch (e) { toast(e.message, true); }
    };
    card.querySelectorAll('.rdel').forEach((b) => {
      b.onclick = async (ev) => {
        ev.stopPropagation();
        if (!confirm('删除这条回复？')) return;
        try {
          await api('/api/replies/' + b.dataset.rid, { method: 'DELETE' });
          if (note) note.replies = (note.replies || []).filter((r) => r.id !== b.dataset.rid);
          paint({ keepScroll: true });
        } catch (e) { toast(e.message, true); }
      };
    });
  });
}

function bindHoverLinks(root) {
  const notesFor = (idsStr) => (idsStr || '').split(',').filter(Boolean)
    .map((id) => root.querySelector('.note[data-id="' + id + '"]')).filter(Boolean);

  root.querySelectorAll('.hl[data-ids]').forEach((sp) => {
    sp.onmouseenter = () => notesFor(sp.dataset.ids).forEach((c) => c.classList.add('hit'));
    sp.onmouseleave = () => notesFor(sp.dataset.ids).forEach((c) => c.classList.remove('hit'));
  });
  root.querySelectorAll('.mk[data-id]').forEach((sp) => {
    sp.onmouseenter = () => notesFor(sp.dataset.id).forEach((c) => c.classList.add('hit'));
    sp.onmouseleave = () => notesFor(sp.dataset.id).forEach((c) => c.classList.remove('hit'));
  });
  root.querySelectorAll('.note').forEach((card) => {
    card.onmouseenter = () => {
      root.querySelectorAll('.hl[data-ids],.mk[data-id]').forEach((sp) => {
        const ids = sp.dataset.ids || sp.dataset.id || '';
        if (ids.split(',').indexOf(card.dataset.id) >= 0) sp.classList.add('hit');
      });
    };
    card.onmouseleave = () => {
      root.querySelectorAll('.hl.hit,.mk.hit').forEach((sp) => sp.classList.remove('hit'));
    };
  });
}

/* ================= 划选工具条 ================= */

let pendingSel = null;

function hideSelBar() {
  const b = document.getElementById('selBar');
  if (b) b.style.display = 'none';
  pendingSel = null;
}

function readSelection() {
  if (!cur) return null;
  if (!document.getElementById('overlay').classList.contains('hidden')) return null;
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const node = range.startContainer;
  const el = node.nodeType === 1 ? node : node.parentElement;
  const paraEl = el && el.closest ? el.closest('.para') : null;
  if (!paraEl || !paraEl.id || !paraEl.id.startsWith('p-')) return null;
  // 克隆选区并去掉编号小签，保证 quote 仍能和原文逐字对上
  let text = '';
  try {
    const frag = range.cloneContents();
    frag.querySelectorAll && frag.querySelectorAll('.mk').forEach((n) => n.remove());
    text = (frag.textContent || '').replace(/[ \t]+/g, ' ').trim();
  } catch {
    text = String(sel).trim();
  }
  if (!text || text.length < 2) return null;
  const paraIdx = Number(paraEl.id.slice(2));
  if (!cur.paras[paraIdx]) return null;
  return { text, paraIdx, rect: range.getBoundingClientRect() };
}

function showSelBar() {
  const sel = readSelection();
  const bar = document.getElementById('selBar');
  if (!sel) { bar.style.display = 'none'; pendingSel = null; return; }
  pendingSel = sel;
  bar.style.display = 'flex';
  bar.style.left = Math.max(90, sel.rect.left + sel.rect.width / 2) + 'px';
  bar.style.top = Math.max(58, sel.rect.top) + 'px';
}

document.addEventListener('mouseup', (e) => {
  if (e.target && e.target.closest && e.target.closest('#selBar,.modal')) return;
  setTimeout(showSelBar, 10);
});
document.addEventListener('selectionchange', debounce(showSelBar, 380));
window.addEventListener('scroll', () => { if (pendingSel) hideSelBar(); }, { passive: true });
window.addEventListener('resize', () => { if (pendingSel) hideSelBar(); });

document.getElementById('selBar').addEventListener('pointerdown', (e) => e.preventDefault());
document.querySelectorAll('#selBar button').forEach((b) => {
  b.addEventListener('click', () => {
    if (!pendingSel) return;
    const ps = pendingSel;
    const act = b.dataset.act;
    hideSelBar();
    const s = window.getSelection();
    if (s) s.removeAllRanges();
    if (act === 'note') openAdd(ps.paraIdx, ps.text);
    else if (act === 'dict') openDict(ps.text);
    else openAsk(ps.paraIdx, ps.text);
  });
});

/* ================= 添加批注 ================= */

function openAdd(paraIdx, quote) {
  const para = cur.paras[paraIdx];
  if (!para) return;
  let author = session.userId;
  let type = 'kaodian';
  const box = openModal(
    '<h3>发一条批注</h3><div class="mh">《' + esc(cur.book.title) + '》 · ' +
    (quote ? '针对<b>你选中的这句话</b>' : '针对这一段') + '</div>' +
    '<label>谁在说话</label><div class="seg">' +
    '<button id="mDad">' + esc(userName('dad')) + '</button>' +
    '<button id="mSon">' + esc(userName('son')) + '</button></div>' +
    '<label>批注类型</label><div class="chips">' +
    Object.keys(TYPES).filter((t) => t !== 'aiask').map((t) =>
      '<button data-t="' + t + '"' + (t === type ? ' class="on"' : '') + '>' + TYPES[t] + ' · ' + TYPE_DESC[t] + '</button>').join('') +
    '</div>' +
    '<label>针对的原文（摘录，可留空）</label>' +
    '<input type="text" id="mQuote" value="' + esc(quote) + '" placeholder="留空表示针对整段">' +
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
          bookId: cur.book.id, paraIdx, author, type,
          quote: box.querySelector('#mQuote').value.trim(), text
        }
      });
      cur.notes.push({ ...out.note, replies: [] });
      closeModal();
      paint({ keepScroll: true });
      const el = document.getElementById('p-' + paraIdx);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
      }
      if (out.warning) toast(out.warning, true);
      else toast('批注已挂上');
    } catch (e) { toast(e.message, true); }
  };
  setTimeout(() => box.querySelector('#mText').focus(), 50);
}

/* ================= 查字词 ================= */

async function openDict(term) {
  const box = openModal('<h3>查字词</h3><div class="mh">「' + esc(term.slice(0, 30)) + '」</div>' +
    '<div class="dictmiss">查询中…</div>' +
    '<div class="btns"><button class="ok" id="dOk">关闭</button></div>');
  box.querySelector('#dOk').onclick = closeModal;
  try {
    const r = await api('/api/dict?w=' + encodeURIComponent(term));
    if (!r || r.found === false) {
      box.innerHTML = '<h3>查字词</h3>' +
        '<div class="dictword">' + esc(term.length > 12 ? term.slice(0, 12) + '…' : term) + '</div>' +
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
    box.innerHTML = '<h3>查字词</h3><div class="dictmiss">查询失败：' + esc(e.message) + '</div>' +
      '<div class="btns"><button class="ok" id="dOk">关闭</button></div>';
    box.querySelector('#dOk').onclick = closeModal;
  }
}

/* ================= 问 AI ================= */

function openAsk(paraIdx, quote) {
  const box = openModal(
    '<h3>问 AI</h3><div class="mh">《' + esc(cur.book.title) + '》 · 针对你划选的这句话</div>' +
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
    startAsk(paraIdx, quote, q);
  };
  box.querySelector('#askSend').onclick = send;
  box.querySelector('#askTa').onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };
  setTimeout(() => box.querySelector('#askTa').focus(), 60);
}

function ensureNote(note) {
  const found = cur.notes.find((n) => n.id === note.id);
  if (found) { Object.assign(found, note); return found; }
  const n = { ...note, replies: note.replies || [] };
  cur.notes.push(n);
  return n;
}

async function startAsk(paraIdx, quote, question) {
  let noteId = null;
  try {
    await streamSSE('/api/ai/ask', { bookId: cur.book.id, paraIdx, quote, question }, {
      onStart(note) {
        noteId = note.id;
        streaming.add(note.id);
        ensureNote(note);
        EXPANDED_PARA.add(paraIdx);
        paint({ keepScroll: true });
        setTimeout(() => scrollToNote(note.id), 60);
      },
      onDelta(text) { appendDelta(noteId, text); },
      onDone(note) { finishNote(note); },
      onError(msg) { failNote(noteId, msg); }
    });
  } catch (e) {
    if (noteId) failNote(noteId, e.message);
    else toast(e.message, true);
  }
}

async function retryAI(noteId) {
  const n = cur.notes.find((x) => x.id === noteId);
  if (!n) return;
  streaming.add(noteId);
  n.answer = null;
  paint({ keepScroll: true });
  try {
    await streamSSE('/api/ai/retry/' + noteId, {}, {
      onStart() { appendLoading(noteId); },
      onDelta(text) { appendDelta(noteId, text); },
      onDone(note) { finishNote(note); },
      onError(msg) { failNote(noteId, msg); }
    });
  } catch (e) {
    failNote(noteId, e.message);
  }
}

function appendDelta(noteId, text) {
  if (!noteId) return;
  const ans = document.querySelector('.note[data-id="' + noteId + '"] .ans');
  if (!ans) return;
  if (ans.classList.contains('loading') || ans.dataset.reset !== '1') {
    ans.innerHTML = '';
    ans.classList.remove('loading');
    ans.dataset.reset = '1';
  }
  ans.textContent += text;
}

function appendLoading(noteId) {
  const ans = document.querySelector('.note[data-id="' + noteId + '"] .ans');
  if (!ans) return;
  ans.className = 'ans loading';
  ans.dataset.reset = '';
  ans.innerHTML = 'AI 正在读这句话<span class="dots"><i></i><i></i><i></i></span>';
}

function finishNote(note) {
  streaming.delete(note.id);
  const n = cur.notes.find((x) => x.id === note.id);
  if (n) n.answer = note.answer;
  const ans = document.querySelector('.note[data-id="' + note.id + '"] .ans');
  if (ans) {
    ans.className = 'ans';
    ans.dataset.reset = '';
    ans.textContent = note.answer || '（模型没有返回内容）';
  }
  repaintParaText(note.paraIdx);
}

function failNote(noteId, msg) {
  streaming.delete(noteId);
  const n = cur.notes.find((x) => x.id === noteId);
  if (n) n.answer = null;
  const card = document.querySelector('.note[data-id="' + noteId + '"]');
  if (!card) { toast('AI 回答失败：' + msg, true); return; }
  const ans = card.querySelector('.ans');
  if (ans) {
    ans.className = 'ans';
    ans.dataset.reset = '';
    ans.innerHTML = '<span style="color:var(--accent)">回答失败：' + esc(msg) + '</span> ' +
      '<button class="retry tbtn" data-id="' + esc(noteId) + '">重试</button>';
    const btn = ans.querySelector('.retry');
    if (btn) btn.onclick = (ev) => { ev.stopPropagation(); retryAI(noteId); };
  }
}

function scrollToNote(id) {
  const card = document.querySelector('.note[data-id="' + id + '"]');
  if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/* ================= 阅读进度 ================= */

const saveProgress = debounce(() => {
  if (!cur || document.getElementById('reader').style.display === 'none') return;
  const rows = document.querySelectorAll('.para-row');
  let last = 0;
  for (const row of rows) {
    if (row.getBoundingClientRect().top <= 150) last = Number(row.dataset.i);
    else break;
  }
  api('/api/progress', { method: 'POST', body: { bookId: cur.book.id, paraIdx: last } }).catch(() => {});
}, 1500);

window.addEventListener('scroll', saveProgress, { passive: true });
