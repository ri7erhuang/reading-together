import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decodeBuffer, parseBook, fingerprint } from '../server/importers/index.js';
import { parseTxt, __test as txtTest } from '../server/importers/txt.js';
import { isZip } from '../server/importers/zip.js';

test('decodeBuffer：UTF-8 原样返回', () => {
  const buf = Buffer.from('第一章 测试', 'utf8');
  assert.equal(decodeBuffer(buf), '第一章 测试');
});

test('decodeBuffer：GBK 中文能正确解码（不会再乱码）', () => {
  // "中文测试" 的 GBK 字节
  const buf = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4]);
  assert.equal(decodeBuffer(buf), '中文测试');
});

test('decodeBuffer：UTF-8 BOM 会被去掉', () => {
  const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('带BOM', 'utf8')]);
  assert.equal(decodeBuffer(buf), '带BOM');
});

test('decodeBuffer：UTF-16LE 可识别', () => {
  const text = '编码识别';
  const buf = Buffer.from('\ufeff' + text, 'utf16le');
  assert.equal(decodeBuffer(buf), text);
});

test('decodeBuffer：空输入不炸', () => {
  assert.equal(decodeBuffer(Buffer.alloc(0)), '');
  assert.equal(decodeBuffer(null), '');
});

test('isChapterLine：常见章节标题能识别', () => {
  const { isChapterLine } = txtTest;
  assert.equal(isChapterLine('第一章 起点'), true);
  assert.equal(isChapterLine('第二十回 归途'), true);
  assert.equal(isChapterLine('Chapter 3'), true);
  assert.equal(isChapterLine('一、缘起'), true);
  assert.equal(isChapterLine('1. 开局'), true);
  assert.equal(isChapterLine('序章'), true);
});

test('isChapterLine：正文句子不会被误判为章节', () => {
  const { isChapterLine } = txtTest;
  assert.equal(isChapterLine('他走进屋子，看见桌上有一封信。'), false);
  assert.equal(isChapterLine('第一条规则是：不要相信任何人，尤其是在下雨的夜里。'), false);
  assert.equal(isChapterLine('123'), false);
});

test('splitLongBlock：优先在句末切分，不从句子中间硬切', () => {
  const { splitLongBlock } = txtTest;
  const sentence = '这是一个测试句子。';
  const text = sentence.repeat(120); // 约 1080 字
  const parts = splitLongBlock(text, 900);
  assert.ok(parts.length >= 2);
  for (const p of parts.slice(0, -1)) {
    assert.equal(p.endsWith('。'), true, '切片应以句号结尾');
  }
});

test('splitLongBlock：短段落不切', () => {
  const { splitLongBlock } = txtTest;
  assert.deepEqual(splitLongBlock('短', 900), ['短']);
});

test('parseTxt：按空行分段并按章节标题切开', () => {
  const text = [
    '第一章 起点',
    '',
    '第一段内容。',
    '',
    '第二章 继续',
    '',
    '第二段内容。'
  ].join('\n');
  const parsed = parseTxt(text, '测试书');
  assert.equal(parsed.title, '测试书');
  assert.equal(parsed.chapters.length, 2);
  assert.equal(parsed.chapters[0].title, '第一章 起点');
  assert.equal(parsed.chapters[0].paras[0].text, '第一段内容。');
});

test('parseTxt：没有章节标题时也至少产出一章', () => {
  const parsed = parseTxt('只有一段话，没有任何章节标记。', '未命名');
  assert.equal(parsed.chapters.length, 1);
  assert.equal(parsed.chapters[0].paras.length, 1);
});

test('parseTxt：空内容抛出可读错误', () => {
  assert.throws(() => parseTxt('   \n\n  ', '空'), /没有解析出正文/);
});

test('parseBook：txt 走解析器并带上标题', () => {
  const buf = Buffer.from('第一章 起点\n\n正文内容。', 'utf8');
  const { parsed, sourceType } = parseBook(buf, 'book.txt', '我的书');
  assert.equal(sourceType, 'txt');
  assert.equal(parsed.title, '我的书');
  assert.equal(parsed.chapters.length, 1);
  assert.equal(parsed.chapters[0].title, '第一章 起点');
});

test('parseBook：非 zip 的 .epub 会被当作 txt 并给出可读错误或结果', () => {
  const buf = Buffer.from('这不是一个真的 epub', 'utf8');
  assert.equal(isZip(buf), false);
  // 后缀是 epub 时按 epub 解析，应当抛错而不是崩溃
  assert.throws(() => parseBook(buf, 'fake.epub'), /epub|zip/i);
});

test('fingerprint：同样的内容得到同样的指纹', () => {
  const a = parseTxt('第一段。\n\n第二段。', 'A');
  const b = parseTxt('第一段。\n\n第二段。', 'B');
  const fa = fingerprint(a);
  const fb = fingerprint(b);
  assert.equal(fa.paraCount, fb.paraCount);
  assert.equal(fa.firstHash, fb.firstHash);
});

test('fingerprint：不同内容指纹不同', () => {
  const a = fingerprint(parseTxt('甲。\n\n乙。', 'A'));
  const b = fingerprint(parseTxt('丙。\n\n丁。', 'B'));
  assert.notEqual(a.firstHash, b.firstHash);
});
