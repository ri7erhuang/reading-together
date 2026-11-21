/* 阅读器渲染层：只负责把数据变成 HTML 字符串，不碰事件 */
import { esc, fmtTime, TYPES, findQuote } from '../../ui.js';
import { userName } from '../../store.js';
import { state, notesOfPara } from './state.js';

export const PARA_LIMIT = 2;
export const CLIP = 140;

/**
 * 定位摘录：优先用后端算好的 offset（整段校验），对不上再退回字符串匹配。
 * 只比对前两个字会误判——同一段里常有重复用词。
 */
export function locate(text, note) {
  const t = String(text || '');
  const q = String(note.quote || '').trim();
  if (!q) return null;
  const { offset, qlen } = note;
  if (Number.isInteger(offset) && Number.isInteger(qlen) && qlen > 0) {
    const seg = t.slice(offset, offset + qlen);
    if (seg && sameText(seg, q)) return { s: offset, e: offset + qlen };
  }
  return findQuote(t, q);
}

/** 比较两段文字，忽略引号、括号与空白差异 */
function sameText(a, b) {
  const norm = (s) => String(s || '').replace(/[“”「」『』《》（）()\s]/g, '');
  return norm(a) === norm(b);
}

/** 把段落的批注渲染成句级高亮（重叠区间合并，同句多人取琥珀/AI 紫） */
export function paraHtml(ptext, pn) {
  const ranges = [];
  pn.forEach((n, idx) => {
    if (!n.quote) return;
    const loc = locate(ptext, n);
    if (!loc) return;
    const a = {};
    a[n.author] = 1;
    ranges.push({ s: loc.s, e: loc.e, a, i: idx, id: n.id, author: n.author });
  });
  ranges.sort((x, y) => x.s - y.s);

  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.s < last.e) {
      last.e = Math.max(last.e, r.e);
      for (const k in r.a) last.a[k] = 1;
      last.items.push(r);
    } else {
      merged.push({ s: r.s, e: r.e, a: r.a, items: [r] });
    }
  }

  let html = '';
  let cursor = 0;
  for (const m of merged) {
    const cls = (m.a.dad && m.a.son) ? 'hl-both' : (m.a.ai ? 'hl-ai' : (m.a.dad ? 'hl-dad' : 'hl-son'));
    const ids = m.items.map((x) => x.id).join(',');
    const marks = m.items.sort((x, y) => x.i - y.i).map((x) =>
      '<span class="mk ' + x.author + '" data-id="' + esc(x.id) + '">' + (x.i + 1) + '</span>').join('');
    html += esc(ptext.slice(cursor, m.s)) +
      '<span class="hl ' + cls + '" data-ids="' + esc(ids) + '">' + esc(ptext.slice(m.s, m.e)) + '</span>' + marks;
    cursor = m.e;
  }
  html += esc(ptext.slice(cursor));
  return html.replace(/\n/g, '<br>');
}

/** 长内容折叠：超过 CLIP 先显示摘要 */
export function clipBlock(text, cls, id) {
  const raw = String(text || '');
  const long = raw.length > CLIP;
  const open = state.expandedNote.has(id);
  const body = (long && !open) ? raw.slice(0, CLIP) + '…' : raw;
  let h = '<div class="' + cls + '">' + esc(body) + '</div>';
  if (long) {
    h += '<button class="showmore" data-id="' + esc(id) + '"' + (open ? ' data-collapse="1"' : '') + '>' +
      (open ? '收起' : '展开全文') + '</button>';
  }
  return h;
}

function answerBlock(n) {
  const answer = n.answer;
  if (answer != null && String(answer).trim()) return clipBlock(answer, 'ans', n.id);
  if (state.streaming.has(n.id)) {
    return '<div class="ans loading">AI 正在读这句话<span class="dots"><i></i><i></i><i></i></span></div>';
  }
  return '<div class="ans"><span style="color:var(--ink3);font-size:.9em">上次没有答完</span> ' +
    '<button class="retry tbtn" data-id="' + esc(n.id) + '">重试</button></div>';
}

export function noteHtml(n, no) {
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
    '<span class="when">' + esc(fmtTime(n.time)) + '</span></div>' + body;

  if (rs.length) {
    h += '<div class="replies">';
    for (const r of rs) {
      h += '<div class="reply ' + r.author + '"><b>' + esc(userName(r.author)) + '</b>：' + esc(r.text) +
        '<span class="rt">' + esc(fmtTime(r.time)) + '</span>' +
        '<button class="rdel" data-rid="' + esc(r.id) + '">删</button></div>';
    }
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

/** 一个段落行：原文 + 右侧批注列（整章渲染与局部重绘共用） */
export function paraRowHtml(p) {
  const pn = notesOfPara(p.i);
  const openAll = state.expandedPara.has(p.i);
  const shown = openAll ? pn : pn.slice(0, PARA_LIMIT);

  let h = '<div class="para-row" data-i="' + p.i + '" data-ch="' + p.ch + '">' +
    '<div class="para' + (p.kind === 'sign' ? ' sign' : '') + (p.text.includes('\n') ? ' pre' : '') +
    '" id="p-' + p.i + '">' + paraHtml(p.text, pn) + '</div>' +
    '<div class="notes"><button class="add-para" data-i="' + p.i + '">＋ 批注</button>';

  for (const n of shown) {
    const loc = n.quote ? locate(p.text, n) : null;
    h += noteHtml(n, loc ? pn.indexOf(n) + 1 : null);
  }
  if (pn.length > PARA_LIMIT) {
    h += '<button class="more-btn" data-i="' + p.i + '">' +
      (openAll ? '收起' : '还有 ' + (pn.length - PARA_LIMIT) + ' 条批注 · 展开') + '</button>';
  }
  h += '</div></div>';
  return h;
}

/** 整章的段落 HTML（加载完成后填充到章节容器） */
export function chapterBodyHtml(chapter, paras) {
  let h = '';
  const end = chapter.paraStart + chapter.paraCount;
  for (let i = chapter.paraStart; i < end; i++) {
    const p = paras.get(i);
    if (p) h += paraRowHtml(p);
  }
  return h;
}
