import crypto from 'node:crypto';

export function uid(prefix = 'id') {
  return prefix + '_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex');
}

export function sha1(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex');
}

const pad = (n) => (n < 10 ? '0' : '') + n;

/** 本地时间 YYYY-MM-DD HH:mm，和旧档案格式保持一致 */
export function nowStr(d = new Date()) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

export function todayStr(d = new Date()) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

const QUOTE_TRIMMERS = /^[“「『《（(]+|[”』』》）)]+$/g;

export function normQuote(q) {
  return String(q || '').trim().replace(/^[“「『《（(]+/, '').replace(/[”』』》）)]+$/, '').trim();
}

/**
 * 在段落原文里定位摘录，返回 {offset, len} 或 null。
 * 先逐字匹配，再去掉首尾引号匹配，最后忽略空白差异匹配。
 */
export function locateQuote(text, quote) {
  const t = String(text || '');
  let q = String(quote || '').trim();
  if (!q) return null;
  let i = t.indexOf(q);
  if (i >= 0) return { offset: i, len: q.length };
  const q2 = normQuote(q);
  if (!q2) return null;
  i = t.indexOf(q2);
  if (i >= 0) return { offset: i, len: q2.length };
  const pat = q2.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');
  const m = new RegExp(pat).exec(t);
  if (m) return { offset: m.index, len: m[0].length };
  return null;
}

export function clampText(s, max) {
  s = String(s == null ? '' : s);
  return s.length > max ? s.slice(0, max) : s;
}
