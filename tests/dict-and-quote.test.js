import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseDictOutput } from '../server/dict-parse.js';
import { locateQuote, normQuote } from '../server/util.js';

test('parseDictOutput：两行输出（拼音 + 释义）', () => {
  const r = parseDictOutput('wǎng rán\n失意的样子。', '惘然');
  assert.equal(r.word, '惘然');
  assert.equal(r.pinyin, 'wǎng rán');
  assert.equal(r.def, '失意的样子。');
});

test('parseDictOutput：三行输出（词 + 拼音 + 释义）', () => {
  const r = parseDictOutput('惘然\nwǎng rán\n失意的样子，心里空落落的。', '这一整句话');
  assert.equal(r.word, '惘然');
  assert.equal(r.pinyin, 'wǎng rán');
  assert.match(r.def, /失意/);
});

test('parseDictOutput：带中文标签也能解析', () => {
  const r = parseDictOutput('词语：忐忑\n拼音：tǎn tè\n释义：心神不定。', '忐忑');
  assert.equal(r.word, '忐忑');
  assert.equal(r.pinyin, 'tǎn tè');
  assert.equal(r.def, '心神不定。');
});

test('parseDictOutput：模型只给释义时不瞎猜拼音', () => {
  const r = parseDictOutput('心神不定，七上八下。', '忐忑');
  assert.equal(r.pinyin, '');
  assert.equal(r.def, '心神不定，七上八下。');
});

test('parseDictOutput：空输出不抛错', () => {
  const r = parseDictOutput('', '惘然');
  assert.deepEqual(r, { word: '惘然', pinyin: '', def: '' });
});

test('parseDictOutput：多段输出只取第一段', () => {
  const r = parseDictOutput('tǎn tè\n心神不定。\n\n补充：也写作忐忑不安。', '忐忑');
  assert.equal(r.def, '心神不定。');
});

test('parseDictOutput：超长释义会被截断', () => {
  const long = '很'.repeat(300);
  const r = parseDictOutput('hěn\n' + long, '很');
  assert.ok(r.def.length <= 121);
  assert.ok(r.def.endsWith('…'));
});

test('locateQuote：精确匹配', () => {
  const text = '我似乎从头上浇了一盆冷水。但是，有什么法子呢？';
  assert.deepEqual(locateQuote(text, '浇了一盆冷水'), { offset: 6, len: 6 });
});

test('locateQuote：原文含引号时按原样匹配整个片段', () => {
  const text = '他说：“去拿你的书来。”然后就走开了。';
  const loc = locateQuote(text, '“去拿你的书来。”');
  assert.ok(loc);
  assert.equal(text.slice(loc.offset, loc.offset + loc.len), '“去拿你的书来。”');
});

test('locateQuote：原文没有引号时退化为去引号匹配', () => {
  const text = '去拿你的书来。他说。';
  const loc = locateQuote(text, '“去拿你的书来。”');
  assert.ok(loc);
  assert.equal(loc.offset, 0);
  assert.equal(text.slice(loc.offset, loc.offset + loc.len), '去拿你的书来。');
});

test('locateQuote：忽略空白差异', () => {
  const text = '第一句。第二句。';
  const loc = locateQuote(text, '第一句。 第二句。');
  assert.ok(loc);
  assert.equal(loc.offset, 0);
});

test('locateQuote：找不到返回 null', () => {
  assert.equal(locateQuote('短文本', '完全不相干的一句话'), null);
  assert.equal(locateQuote('短文本', ''), null);
});

test('normQuote：去掉成对引号与书名号', () => {
  assert.equal(normQuote('“引号”'), '引号');
  assert.equal(normQuote('《书名》'), '书名');
  assert.equal(normQuote('  无引号  '), '无引号');
});
