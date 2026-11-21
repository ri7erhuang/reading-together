/* 导入器统一入口：编码探测 + 格式分派 + 指纹（用于查重） */
import crypto from 'node:crypto';
import { parseTxt } from './txt.js';
import { parseEpub } from './epub.js';
import { isZip } from './zip.js';

export { isZip };

/**
 * 文本解码：BOM → 严格 UTF-8 → GB18030 兜底。
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
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    // 不是合法 UTF-8，按国标编码再试一次
  }
  try {
    return new TextDecoder('gb18030').decode(buf);
  } catch {
    return buf.toString('utf8');
  }
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
