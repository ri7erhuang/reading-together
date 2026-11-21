import zlib from 'node:zlib';

/* ============================================================
 * 导入器：把 txt / epub 归一化成
 *   { title, author, chapters: [ { title, paras: [{ text, kind }] } ] }
 * 下游（存储、阅读器、批注）只认这一种结构。
 * ============================================================ */

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ldquo: '“', rdquo: '”',
  lsquo: '‘', rsquo: '’', hellip: '…', mdash: '—', ndash: '–', middot: '·',
  bull: '•', copy: '©', reg: '®', trade: '™', deg: '°', times: '×', divide: '÷'
};

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => {
      const key = name.toLowerCase();
      return Object.prototype.hasOwnProperty.call(ENTITIES, key) ? ENTITIES[key] : m;
    });
}

function safeChar(code) {
  try { return String.fromCodePoint(code); } catch { return ''; }
}

/* ---------------- TXT ---------------- */

const CHAPTER_RE = /^(第[一二三四五六七八九十百千零〇两\d]+[章节回卷篇部]|序章|序言|前言|后记|尾声|楔子|引子)\s*[^\n]{0,40}$/;

function isChapterLine(line) {
  const t = line.trim();
  if (!t || t.length > 46) return false;
  return CHAPTER_RE.test(t);
}

function splitLongBlock(text, max = 900) {
  if (text.length <= max) return [text];
  const out = [];
  let rest = text;
  while (rest.length > max) {
    let cut = -1;
    for (let i = max; i > max * 0.5; i--) {
      if ('。！？；…'.includes(rest[i - 1])) { cut = i; break; }
    }
    if (cut < 0) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut);
  }
  if (rest.trim()) out.push(rest.trim());
  return out;
}

export function parseTxt(rawText, fallbackTitle = '未命名') {
  let text = String(rawText).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  text = text.replace(/\u0000/g, '');

  const lines = text.split('\n');
  const blankCount = lines.reduce((n, l) => n + (l.trim() ? 0 : 1), 0);
  const blocksMode = blankCount >= 3; // 常见排版：段落之间有空行

  const paras = [];
  const chapters = [];
  let current = { title: '正文', paras: [] };

  const pushPara = (t) => {
    t = String(t).replace(/[ \t\u3000]+$/g, '').trim();
    if (!t) return;
    for (const piece of splitLongBlock(t)) current.paras.push({ text: piece, kind: 'para' });
  };

  const pushChapter = (title) => {
    if (current.paras.length) chapters.push(current);
    current = { title: title || '正文', paras: [] };
  };

  if (blocksMode) {
    let block = [];
    const flush = () => {
      if (!block.length) return;
      // 块内多行：如果多数行有缩进，说明每行是一段；否则合并成一段
      const indented = block.filter((l) => /^(\u3000|[ \t]{2,})/.test(l)).length;
      if (block.length > 2 && indented >= block.length * 0.5) {
        block.forEach((l) => {
          if (isChapterLine(l)) pushChapter(l.trim());
          else pushPara(l.replace(/^(\u3000|[ \t]{2,})/, ''));
        });
      } else {
        const joined = block.map((l) => l.trim()).filter(Boolean).join('');
        if (isChapterLine(joined)) pushChapter(joined);
        else pushPara(joined);
      }
      block = [];
    };
    for (const line of lines) {
      if (!line.trim()) { flush(); continue; }
      block.push(line);
    }
    flush();
  } else {
    for (const line of lines) {
      if (!line.trim()) continue;
      if (isChapterLine(line)) pushChapter(line.trim());
      else pushPara(line.replace(/^(\u3000|[ \t]{2,})/, ''));
    }
  }

  if (current.paras.length) chapters.push(current);
  const usable = chapters.map((c) => ({ title: c.title, paras: c.paras }))
    .filter((c) => c.paras.length);
  if (!usable.length) throw new Error('这个 txt 里没有解析出正文，换个文件试试');
  // 只有一个「正文」章节时，标题用首段前 24 字做个提示
  if (usable.length === 1 && usable[0].title === '正文') usable[0].title = '正文';
  return { title: fallbackTitle, author: '', chapters: usable };
}

/* ---------------- EPUB ---------------- */

function readZip(buf) {
  let eocd = -1;
  const min = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是合法的 epub（zip 结构），可能文件损坏或只是改了后缀');

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nlen = buf.readUInt16LE(off + 28);
    const elen = buf.readUInt16LE(off + 30);
    const clen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nlen);
    entries.push({ name, method, csize, lho });
    off += 46 + nlen + elen + clen;
  }
  if (!entries.length) throw new Error('epub 里没有文件条目');

  const files = new Map();
  for (const e of entries) {
    try {
      const nlen = buf.readUInt16LE(e.lho + 26);
      const elen = buf.readUInt16LE(e.lho + 28);
      const start = e.lho + 30 + nlen + elen;
      const raw = buf.subarray(start, start + e.csize);
      files.set(e.name, e.method === 0 ? raw : zlib.inflateRawSync(raw));
    } catch {
      // 个别损坏条目跳过即可
    }
  }
  return files;
}

function resolvePath(baseDir, href) {
  const clean = decodeURIComponent(String(href || '').split('#')[0]);
  const joined = baseDir ? baseDir + '/' + clean : clean;
  const parts = [];
  for (const seg of joined.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

function dirOf(p) {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

function attr(tag, name) {
  const m = new RegExp(name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')', 'i').exec(tag);
  return m ? (m[2] != null ? m[2] : m[3]) : '';
}

function textOfHtml(html) {
  let s = String(html);
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<head[\s\S]*?<\/head>/gi, '');
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
  return s;
}

function htmlToParas(html) {
  let s = textOfHtml(html);
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
      const idref = attr(tag, 'idref');
      const item = manifest.get(idref);
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
