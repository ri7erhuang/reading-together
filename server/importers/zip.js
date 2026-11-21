/* ZIP 读取（epub 用）：支持 zip64、越界保护、解压体积上限 */
import zlib from 'node:zlib';

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_LOCATOR64 = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;

const MAX_ENTRIES = 5000;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

function need(buf, off, len) {
  if (off < 0 || len < 0 || off + len > buf.length) {
    throw new Error('epub 文件结构不完整（读取越界），可能已损坏');
  }
}

const u16 = (buf, off) => { need(buf, off, 2); return buf.readUInt16LE(off); };
const u32 = (buf, off) => { need(buf, off, 4); return buf.readUInt32LE(off); };
const u64 = (buf, off) => { need(buf, off, 8); return Number(buf.readBigUInt64LE(off)); };

function findEocd(buf) {
  const min = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= min; i--) {
    if (u32(buf, i) === SIG_EOCD) return i;
  }
  return -1;
}

/** zip64 的中央目录条目数量/偏移存在 EOCD 前的 locator 里 */
function readZip64Eocd(buf, eocd) {
  const locOff = eocd - 20;
  if (locOff < 0 || u32(buf, locOff) !== SIG_LOCATOR64) return null;
  const z64Off = u64(buf, locOff + 8);
  if (u32(buf, z64Off) !== SIG_EOCD64) return null;
  return {
    count: u64(buf, z64Off + 32),
    centralOffset: u64(buf, z64Off + 48)
  };
}

/** 从 extra field 中取 zip64 扩展里的压缩后大小 */
function zip64CompressedSize(buf, extraOff, extraLen) {
  const end = extraOff + extraLen;
  let p = extraOff;
  while (p + 4 <= end) {
    const id = u16(buf, p);
    const size = u16(buf, p + 2);
    if (id === 0x0001) {
      const base = p + 4;
      // 顺序：未压缩大小(8)、压缩大小(8)、本地头偏移(4)
      if (base + 16 <= end) return u64(buf, base + 8);
      return null;
    }
    p += 4 + size;
  }
  return null;
}

/**
 * 读取 zip 内所有条目，返回 Map<文件名, Buffer>。
 * 只解压，不落盘；损坏条目跳过，结构性问题抛出可读错误。
 */
export function readZip(buf) {
  if (!buf || buf.length < 22) throw new Error('不是合法的 epub（文件太小）');
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('不是合法的 epub（zip 结构），可能文件损坏或只是改了后缀');

  let count = u16(buf, eocd + 10);
  let off = u32(buf, eocd + 16);
  if (count === 0xffff || off === 0xffffffff) {
    const z64 = readZip64Eocd(buf, eocd);
    if (z64) { count = z64.count; off = z64.centralOffset; }
  }
  if (count > MAX_ENTRIES) throw new Error('epub 内文件条目过多（' + count + '），已拒绝解析');

  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (u32(buf, off) !== SIG_CENTRAL) break;
    const method = u16(buf, off + 10);
    let csize = u32(buf, off + 20);
    const nlen = u16(buf, off + 28);
    const elen = u16(buf, off + 30);
    const clen = u16(buf, off + 32);
    const lho = u32(buf, off + 42);
    need(buf, off + 46, nlen);
    const name = buf.toString('utf8', off + 46, off + 46 + nlen);

    if (csize === 0xffffffff) {
      const z = zip64CompressedSize(buf, off + 46 + nlen, elen);
      if (z == null) throw new Error('epub 使用了不支持的 zip64 条目：' + name);
      csize = z;
    }
    // 未压缩大小用于声明解压上限，防御压缩炸弹
    let usize = u32(buf, off + 24);
    if (usize === 0xffffffff) usize = 0;

    try {
      need(buf, lho + 26, 4);
      const lnlen = u16(buf, lho + 26);
      const lelen = u16(buf, lho + 28);
      const start = lho + 30 + lnlen + lelen;
      need(buf, start, csize);
      const raw = buf.subarray(start, start + csize);
      if (method === 0) {
        files.set(name, raw);
      } else if (method === 8) {
        const limit = usize > 0 ? Math.min(usize + 1024, MAX_ENTRY_BYTES) : MAX_ENTRY_BYTES;
        files.set(name, zlib.inflateRawSync(raw, { maxOutputLength: limit }));
      }
    } catch {
      // 单个条目损坏不影响整本书，跳过
    }
    off += 46 + nlen + elen + clen;
  }
  if (!files.size) throw new Error('epub 里没有可读取的文件条目');
  return files;
}

export function isZip(buf) {
  return !!buf && buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}
