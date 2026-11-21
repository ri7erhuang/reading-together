/* 导入器统一入口：编码探测 + 格式分派 + 指纹（用于查重） */
import crypto from 'node:crypto';
import { parseTxt } from './txt.js';
import { parseEpub } from './epub.js';
import { isZip } from './zip.js';

export { isZip };

/** 无 BOM 的 UTF-16：用 NUL 字节的奇偶分布探测（中文高字节多为 0） */
function detectUtf16(buf) {
  const n = Math.min(buf.length, 2000);
  if (n < 20) return null;
  let evenNul = 0;
  let oddNul = 0;
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) { if (i % 2 === 0) evenNul++; else oddNul++; }
  }
  if (oddNul / n > 0.15) return 'utf-16le';
  if (evenNul / n > 0.15) return 'utf-16be';
  return null;
}

/** 解码结果是否像正常文本：防止把二进制文件当 GBK 解成乱码存进书库 */
function looksLikeText(s) {
  const n = Math.min(String(s).length, 4000);
  if (!n) return false;
  let ok = 0;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13) { ok++; continue; }
    if (c < 32 || c === 0xfffd) continue;
    if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) ||
      (c >= 0x20 && c <= 0x7e) || (c >= 0x3000 && c <= 0x303f) ||
      (c >= 0xff00 && c <= 0xffef) || (c >= 0x2000 && c <= 0x206f)) ok++;
  }
  return ok / n > 0.85;
}

/**
 * 文本解码：BOM → 无 BOM 的 UTF-16 → 严格 UTF-8 → GB18030 兜底。
 * 国内 txt 大量是 GBK/GB18030，直接按 UTF-8 解会整本乱码。
 */
export function decodeBuffer(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) return '';
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(buf.subarray(3));
  }
  if (buf[0] === 0xff && buf[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(buf.subarray(2));
  }
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(buf.subarray(2));
  }

  const u16 = detectUtf16(buf);
  if (u16) {
    const text = new TextDecoder(u16).decode(buf);
    if (looksLikeText(text)) return text;
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    // 不是合法 UTF-8，按国标编码再试一次
  }

  const gbk = new TextDecoder('gb18030').decode(buf);
  if (!looksLikeText(gbk)) {
    throw new Error('无法识别这个文件的编码（可能是二进制文件或特殊编码的电子书）');
  }
  return gbk;
}

/** 根据文件名/魔数选择解析器，返回 { parsed, sourceType } */
export function parseBook(buf, fileName = 'book.txt', titleHint = '') {
  const epub = /\.epub$/i.test(fileName) || isZip(buf);
  const title = titleHint || String(fileName).replace(/\.[^.]+$/, '') || '未命名';
  const parsed = epub ? parseEpub(buf) : parseTxt(decodeBuffer(buf), title);
  if (titleHint) parsed.title = titleHint;
  return { parsed, sourceType: epub ? 'epub' : 'txt' };
}

/** 书指纹：段落总数 + 首段哈希，用于识别重复导入 */
export function fingerprint(parsed) {
  const paras = parsed.chapters.flatMap((c) => c.paras);
  const first = String(paras[0]?.text || '');
  const hash = crypto.createHash('sha1').update(first).digest('hex').slice(0, 16);
  return { paraCount: paras.length, firstHash: hash };
}
