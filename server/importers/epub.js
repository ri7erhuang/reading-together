/* EPUB 解析：OPF 清单 → spine 顺序 → 每章 HTML 转段落 */
import { readZip } from './zip.js';

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ldquo: '“', rdquo: '”',
  lsquo: '‘', rsquo: '’', hellip: '…', mdash: '—', ndash: '–', middot: '·',
  bull: '•', copy: '©', reg: '®', trade: '™', deg: '°', times: '×', divide: '÷'
};

function safeChar(code) {
  try { return String.fromCodePoint(code); } catch { return ''; }
}

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => {
      const key = name.toLowerCase();
      return Object.prototype.hasOwnProperty.call(ENTITIES, key) ? ENTITIES[key] : m;
    });
}

function resolvePath(baseDir, href) {
  let clean = String(href || '').split('#')[0];
  try { clean = decodeURIComponent(clean); } catch {}
  const joined = baseDir ? baseDir + '/' + clean : clean;
  const parts = [];
  for (const seg of joined.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (p) => {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
};

function attr(tag, name) {
  // 加词边界，避免把 data-id / data-href 误当成 id / href
  const m = new RegExp('(?:^|\\s)' + name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')', 'i').exec(tag);
  return m ? (m[2] != null ? m[2] : m[3]) : '';
}

function htmlToParas(html) {
  let s = String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|h[1-6]|li|blockquote|section|article|tr|td|dd|dt|figcaption)>/gi, '\n\n');
  s = s.replace(/<(p|div|h[1-6]|li|blockquote|section|article|tr|td|dd|dt|figcaption)\b[^>]*>/gi, '\n\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s).replace(/\u00a0/g, ' ');
  return s.split(/\n\s*\n/)
    .map((p) => p.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim())
    .filter(Boolean);
}

function firstHeading(html) {
  const m = /<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/i.exec(String(html));
  if (!m) return '';
  return decodeEntities(String(m[2]).replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

function docTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html));
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : '';
}

export function parseEpub(buf) {
  const files = readZip(buf);
  const read = (p) => {
    const b = files.get(p);
    return b ? b.toString('utf8') : '';
  };

  const container = read('META-INF/container.xml') || read('meta-inf/container.xml');
  let opfPath = '';
  if (container) {
    const m = /<rootfile\b[^>]*>/i.exec(container);
    if (m) opfPath = attr(m[0], 'full-path');
  }
  if (!opfPath) {
    for (const name of files.keys()) {
      if (/\.opf$/i.test(name)) { opfPath = name; break; }
    }
  }
  if (!opfPath) throw new Error('epub 里找不到 OPF 清单文件');

  const opf = read(opfPath);
  const opfDir = dirOf(opfPath);

  const titleM = /<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i.exec(opf);
  const creatorM = /<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i.exec(opf);
  const bookTitle = titleM ? decodeEntities(titleM[1]).trim() : '';
  const author = creatorM ? decodeEntities(creatorM[1]).replace(/<[^>]+>/g, '').trim() : '';

  const manifest = new Map();
  const itemRe = /<item\b[^>]*>/gi;
  let m;
  while ((m = itemRe.exec(opf))) {
    const tag = m[0];
    const id = attr(tag, 'id');
    if (!id) continue;
    manifest.set(id, {
      href: resolvePath(opfDir, attr(tag, 'href')),
      type: attr(tag, 'media-type'),
      props: attr(tag, 'properties')
    });
  }

  const spine = [];
  const spineBlock = /<spine\b[\s\S]*?<\/spine>/i.exec(opf);
  if (spineBlock) {
    const refRe = /<itemref\b[^>]*>/gi;
    let r;
    while ((r = refRe.exec(spineBlock[0]))) {
      const tag = r[0];
      if (/linear\s*=\s*["']no["']/i.test(tag)) continue;
      const item = manifest.get(attr(tag, 'idref'));
      if (item) spine.push(item);
    }
  }
  if (!spine.length) {
    for (const item of manifest.values()) {
      if (/xhtml|html/i.test(item.type)) spine.push(item);
    }
  }
  if (!spine.length) throw new Error('epub 的 spine 里没有可读的章节');

  // 目录标题：优先 epub3 nav，其次 ncx
  const titles = new Map();
  const navItem = [...manifest.values()].find((i) => /\bnav\b/.test(i.props || ''));
  if (navItem) {
    const navHtml = read(navItem.href);
    const aRe = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;
    let a;
    while ((a = aRe.exec(navHtml))) {
      const tag = /<a\b[^>]*>/i.exec(a[0]);
      if (!tag) continue;
      const target = resolvePath(dirOf(navItem.href), attr(tag[0], 'href'));
      const label = decodeEntities(String(a[1]).replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
      if (target && label && !titles.has(target)) titles.set(target, label);
    }
  }
  if (!titles.size) {
    const ncx = [...manifest.values()].find((i) => /ncx/i.test(i.type || ''));
    if (ncx) {
      const xml = read(ncx.href);
      const navRe = /<navPoint\b[\s\S]*?<\/navPoint>/gi;
      let np;
      while ((np = navRe.exec(xml))) {
        const block = np[0];
        const labelM = /<text[^>]*>([\s\S]*?)<\/text>/i.exec(block);
        const srcM = /<content\b[^>]*>/i.exec(block);
        if (!labelM || !srcM) continue;
        const target = resolvePath(dirOf(ncx.href), attr(srcM[0], 'src'));
        const label = decodeEntities(labelM[1]).replace(/\s+/g, ' ').trim();
        if (target && label && !titles.has(target)) titles.set(target, label);
      }
    }
  }

  const chapters = [];
  spine.forEach((item, index) => {
    if (!/xhtml|html/i.test(item.type || '') && !/\.x?html?$/i.test(item.href)) return;
    if (/\bnav\b/.test(item.props || '')) return;
    const html = read(item.href);
    if (!html) return;
    let paras = htmlToParas(html);
    if (!paras.length) return;
    if (paras.join('').length < 20) return;

    let title = titles.get(item.href) || firstHeading(html) || docTitle(html);
    if (!title) title = '第 ' + (index + 1) + ' 节';
    title = title.replace(/\s+/g, ' ').trim().slice(0, 60);
    if (paras[0] && paras[0].replace(/\s/g, '') === title.replace(/\s/g, '')) paras = paras.slice(1);
    if (!paras.length) return;
    chapters.push({ title, paras: paras.map((t) => ({ text: t, kind: 'para' })) });
  });

  if (!chapters.length) throw new Error('epub 里没有解析出正文（可能是纯图片排版的书）');
  return { title: bookTitle || '未命名', author, chapters };
}
