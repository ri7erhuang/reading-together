export const TYPES = { tucao: '吐槽', question: '疑问', kaodian: '考点雷达', brilliant: '神来之笔', aiask: '助读' };
export const TYPE_DESC = {
  tucao: '怎么皮怎么来',
  question: '读到不懂就问',
  kaodian: '贴近考点的正经批注',
  brilliant: '原文写得太好了'
};

export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function fmtTime(t) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}:\d{2})$/.exec(t || '');
  if (!m) return t || '';
  const now = new Date().getFullYear();
  return (m[1] === String(now) ? '' : m[1] + '年 ') + parseInt(m[2], 10) + '月' + parseInt(m[3], 10) + '日 ' + m[4];
}

export function openModal(html) {
  const box = document.getElementById('modalBox');
  box.innerHTML = html;
  document.getElementById('overlay').classList.remove('hidden');
  return box;
}

export function closeModal() {
  document.getElementById('overlay').classList.add('hidden');
  document.getElementById('modalBox').innerHTML = '';
}

let toastTimer = 0;
export function toast(msg, bad) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'on' + (bad ? ' bad' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, bad ? 4200 : 2600);
}

export function setLoading(on, text) {
  const el = document.getElementById('loading');
  if (text) el.textContent = text;
  el.classList.toggle('on', !!on);
}

export function debounce(fn, ms) {
  let t = 0;
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), ms);
  };
}

/** 在段落原文里定位摘录：逐字 → 去首尾引号 → 忽略空白 */
export function findQuote(text, quote) {
  const t = String(text || '');
  let q = String(quote || '').trim();
  if (!q) return null;
  let i = t.indexOf(q);
  if (i >= 0) return { s: i, e: i + q.length };
  q = q.replace(/^[“「『《（(]+/, '').replace(/[”』』》）)]+$/, '').trim();
  if (!q) return null;
  i = t.indexOf(q);
  if (i >= 0) return { s: i, e: i + q.length };
  const pat = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');
  const m = new RegExp(pat).exec(t);
  return m ? { s: m.index, e: m.index + m[0].length } : null;
}
