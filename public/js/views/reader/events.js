/* 阅读器事件层：段落行的事件绑定、局部重绘、原文与卡片的悬停联动 */
import { api, session } from '../../api.js';
import { toast } from '../../ui.js';
import { state, hooks, noteById, removeNoteLocal } from './state.js';
import { paraRowHtml } from './render.js';
import { observeParaRow, unobserveParaRow } from './progress.js';
import { retryAsk } from './ai.js';
import { openAdd } from './actions.js';

/** 只重建某一段落的行，避免整页重绘导致的滚动跳动与流式丢字 */
export function repaintPara(i) {
  const row = document.querySelector('.para-row[data-i="' + i + '"]');
  const p = state.paras.get(i);
  if (!row || !p) return;

  // 保留正在编辑的回复草稿（重绘会把 textarea 清空）
  const drafts = [];
  row.querySelectorAll('.note').forEach((card) => {
    const box = card.querySelector('.reply-box');
    const ta = card.querySelector('.reply-box textarea');
    if (box && box.classList.contains('open') && ta && ta.value.trim()) {
      drafts.push({ id: card.dataset.id, value: ta.value });
    }
  });

  unobserveParaRow(row);
  const holder = document.createElement('div');
  holder.innerHTML = paraRowHtml(p);
  const next = holder.firstElementChild;
  if (!next) return;
  row.replaceWith(next);
  bindParaRow(next);
  observeParaRow(next);

  drafts.forEach((d) => {
    const card = next.querySelector('.note[data-id="' + d.id + '"]');
    if (!card) return;
    const box = card.querySelector('.reply-box');
    const ta = card.querySelector('textarea');
    if (box && ta) {
      box.classList.add('open');
      ta.value = d.value;
    }
  });
}

function bindHover(row) {
  const cardsOf = (idsStr) => String(idsStr || '').split(',').filter(Boolean)
    .map((id) => row.querySelector('.note[data-id="' + id + '"]')).filter(Boolean);

  row.querySelectorAll('.hl[data-ids]').forEach((sp) => {
    sp.onmouseenter = () => cardsOf(sp.dataset.ids).forEach((c) => c.classList.add('hit'));
    sp.onmouseleave = () => cardsOf(sp.dataset.ids).forEach((c) => c.classList.remove('hit'));
  });
  row.querySelectorAll('.mk[data-id]').forEach((sp) => {
    sp.onmouseenter = () => cardsOf(sp.dataset.id).forEach((c) => c.classList.add('hit'));
    sp.onmouseleave = () => cardsOf(sp.dataset.id).forEach((c) => c.classList.remove('hit'));
  });
  row.querySelectorAll('.note').forEach((card) => {
    card.onmouseenter = () => {
      row.querySelectorAll('.hl[data-ids],.mk[data-id]').forEach((sp) => {
        const ids = sp.dataset.ids || sp.dataset.id || '';
        if (ids.split(',').indexOf(card.dataset.id) >= 0) sp.classList.add('hit');
      });
    };
    card.onmouseleave = () => {
      row.querySelectorAll('.hl.hit,.mk.hit').forEach((sp) => sp.classList.remove('hit'));
    };
  });
}

function bindNoteCard(card, paraIdx) {
  const nid = card.dataset.id;
  const note = noteById(nid);

  card.onclick = (ev) => {
    if (ev.target.closest('.reply-box,.replies,.reply-btn,.rdel,.del,.showmore,.retry')) return;
    const el = document.getElementById('p-' + paraIdx);
    if (!el) return;
    const hl = el.querySelector('.hl');
    (hl || el).scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  };

  // 删除整条批注
  const del = card.querySelector('.del');
  if (del) {
    del.onclick = async (ev) => {
      ev.stopPropagation();
      if (!confirm('确定删除这条批注吗？')) return;
      // 正在流式回答时先中止，否则 onDone 会把删掉的卡片重新画回来
      if (state.streaming.has(nid)) {
        const abort = state.aborters.get(nid);
        if (abort) { try { abort(); } catch {} }
        state.aborters.delete(nid);
        state.streaming.delete(nid);
      }
      try {
        await api('/api/notes/' + nid, { method: 'DELETE' });
        removeNoteLocal(nid);
        repaintPara(paraIdx);
        toast('已删除');
      } catch (e) { toast(e.message, true); }
    };
  }

  // 回复
  const box = card.querySelector('.reply-box');
  if (!box) return;
  const ta = box.querySelector('textarea');
  let pick = session.userId;
  const paintWho = () => {
    card.querySelectorAll('.who button').forEach((b) => {
      b.className = b.dataset.a === pick ? 'on-' + pick : '';
    });
  };
  paintWho();
  card.querySelectorAll('.who button').forEach((b) => {
    b.onclick = (ev) => { ev.stopPropagation(); pick = b.dataset.a; paintWho(); };
  });
  const replyBtn = card.querySelector('.reply-btn');
  if (replyBtn) {
    replyBtn.onclick = (ev) => {
      ev.stopPropagation();
      const open = box.classList.toggle('open');
      if (open) ta.focus();
    };
  }
  box.querySelector('.cn').onclick = (ev) => {
    ev.stopPropagation();
    box.classList.remove('open');
    ta.value = '';
  };
  box.querySelector('.send').onclick = async (ev) => {
    ev.stopPropagation();
    const t = ta.value.trim();
    if (!t) { ta.focus(); return; }
    try {
      const out = await api('/api/notes/' + nid + '/replies', { method: 'POST', body: { text: t, author: pick } });
      const n = noteById(nid);
      if (n) {
        n.replies = n.replies || [];
        n.replies.push(out.reply);
      }
      repaintPara(paraIdx);
    } catch (e) { toast(e.message, true); }
  };

  card.querySelectorAll('.rdel').forEach((b) => {
    b.onclick = async (ev) => {
      ev.stopPropagation();
      if (!confirm('删除这条回复？')) return;
      try {
        await api('/api/replies/' + b.dataset.rid, { method: 'DELETE' });
        const n = noteById(nid);
        if (n) n.replies = (n.replies || []).filter((r) => r.id !== b.dataset.rid);
        repaintPara(paraIdx);
      } catch (e) { toast(e.message, true); }
    };
  });
}

/** 绑定一个段落行的全部交互 */
export function bindParaRow(row) {
  const i = Number(row.dataset.i);

  const add = row.querySelector('.add-para');
  if (add) add.onclick = (ev) => { ev.stopPropagation(); openAdd(i, ''); };

  row.querySelectorAll('.more-btn').forEach((b) => {
    b.onclick = (ev) => {
      ev.stopPropagation();
      if (state.expandedPara.has(i)) state.expandedPara.delete(i);
      else state.expandedPara.add(i);
      repaintPara(i);
    };
  });

  row.querySelectorAll('.showmore').forEach((b) => {
    b.onclick = (ev) => {
      ev.stopPropagation();
      const id = b.dataset.id;
      if (b.dataset.collapse) state.expandedNote.delete(id);
      else state.expandedNote.add(id);
      repaintPara(i);
    };
  });

  row.querySelectorAll('.retry').forEach((b) => {
    b.onclick = (ev) => { ev.stopPropagation(); retryAsk(b.dataset.id); };
  });

  // 编号小签可点击：展开该段并滚到对应卡片（被折叠的批注也能从正文找到）
  row.querySelectorAll('.mk[data-id]').forEach((sp) => {
    sp.onclick = (ev) => {
      ev.stopPropagation();
      const id = sp.dataset.id;
      if (!state.expandedPara.has(i)) {
        state.expandedPara.add(i);
        repaintPara(i);
      }
      setTimeout(() => {
        const card = document.querySelector('.note[data-id="' + id + '"]');
        if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 0);
    };
  });

  row.querySelectorAll('.note').forEach((card) => bindNoteCard(card, i));
  bindHover(row);
}

/** 整章渲染后绑定，并把段落交给进度观察器 */
export function bindChapter(root) {
  root.querySelectorAll('.para-row').forEach((row) => {
    bindParaRow(row);
    observeParaRow(row);
  });
}

/** 把重绘能力注册给 state.hooks，供 ai/actions 调用（避免循环依赖） */
export function installReaderHooks() {
  hooks.repaintPara = repaintPara;
}
