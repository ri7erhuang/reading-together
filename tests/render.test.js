import { test } from 'node:test';
import assert from 'node:assert/strict';

import { state, rebuildIndex, notesOfPara } from '../public/js/views/reader/state.js';
import { paraHtml, paraRowHtml, noteHtml, locate, chapterBodyHtml, PARA_LIMIT } from '../public/js/views/reader/render.js';

const P = '我似乎从头上浇了一盆冷水。但是，有什么法子呢？';

function useNotes(list) {
  state.notes = list;
  state.expandedPara.clear();
  state.expandedNote.clear();
  state.streaming.clear();
  rebuildIndex();
}

test('locate：优先使用后端给的 offset', () => {
  assert.deepEqual(locate(P, { quote: '浇了一盆冷水', offset: 6, qlen: 6 }), { s: 6, e: 12 });
});

test('locate：offset 对不上时回退到字符串匹配', () => {
  const loc = locate(P, { quote: '浇了一盆冷水', offset: 999, qlen: 6 });
  assert.ok(loc);
  assert.equal(P.slice(loc.s, loc.e), '浇了一盆冷水');
});

test('paraHtml：父子批注重叠合并为琥珀色，并保留双方 id', () => {
  const pn = [
    { id: 'a', author: 'dad', quote: '浇了一盆冷水', offset: 6, qlen: 6 },
    { id: 'b', author: 'son', quote: '一盆冷水', offset: 9, qlen: 4 }
  ];
  const html = paraHtml(P, pn);
  assert.match(html, /hl-both/);
  assert.match(html, /data-ids="a,b"/);
});

test('paraHtml：单条 AI 批注用紫色样式', () => {
  const html = paraHtml(P, [{ id: 'x', author: 'ai', quote: '有什么法子', offset: 18, qlen: 5 }]);
  assert.match(html, /hl-ai/);
});

test('paraHtml：输出经过转义，不会注入 HTML', () => {
  const html = paraHtml('a<b>c', [{ id: 'x', author: 'dad', quote: '<b>', offset: 1, qlen: 3 }]);
  assert.equal(html.includes('<b>'), false);
  assert.match(html, /&lt;b&gt;/);
});

test(`paraRowHtml：超过 ${PARA_LIMIT} 条时折叠并提示剩余数量`, () => {
  useNotes([
    { id: 'n1', paraIdx: 0, author: 'dad', type: 'kaodian', quote: '我似乎从头上', offset: 0, qlen: 6, text: '1', time: '2026-11-20 10:00', replies: [] },
    { id: 'n2', paraIdx: 0, author: 'son', type: 'tucao', quote: '浇了一盆冷水', offset: 6, qlen: 6, text: '2', time: '2026-11-20 10:01', replies: [] },
    { id: 'n3', paraIdx: 0, author: 'son', type: 'question', quote: '有什么法子', offset: 18, qlen: 5, text: '3', time: '2026-11-20 10:02', replies: [] },
    { id: 'n4', paraIdx: 0, author: 'dad', type: 'brilliant', quote: '但是', offset: 15, qlen: 2, text: '4', time: '2026-11-20 10:03', replies: [] }
  ]);
  const html = paraRowHtml({ i: 0, ch: 0, text: P, kind: 'para' });
  assert.match(html, new RegExp('还有 ' + (4 - PARA_LIMIT) + ' 条批注'));
  assert.equal((html.match(/class="note /g) || []).length, PARA_LIMIT);
});

test('paraRowHtml：展开后显示全部批注', () => {
  useNotes([
    { id: 'n1', paraIdx: 0, author: 'dad', type: 'kaodian', quote: '我似乎从头上', offset: 0, qlen: 6, text: '1', time: '2026-11-20 10:00', replies: [] },
    { id: 'n2', paraIdx: 0, author: 'son', type: 'tucao', quote: '浇了一盆冷水', offset: 6, qlen: 6, text: '2', time: '2026-11-20 10:01', replies: [] },
    { id: 'n3', paraIdx: 0, author: 'son', type: 'question', quote: '有什么法子', offset: 18, qlen: 5, text: '3', time: '2026-11-20 10:02', replies: [] }
  ]);
  state.expandedPara.add(0);
  const html = paraRowHtml({ i: 0, ch: 0, text: P, kind: 'para' });
  assert.equal((html.match(/class="note /g) || []).length, 3);
  assert.match(html, /收起/);
});

test('noteHtml：AI 批注没有答案时显示重试入口', () => {
  const html = noteHtml({ id: 'ai1', paraIdx: 0, author: 'ai', type: 'aiask', quote: '但是', text: '为什么？', answer: null, replies: [], time: '2026-11-20 10:00' }, 1);
  assert.match(html, /上次没有答完/);
  assert.match(html, /class="retry/);
});

test('noteHtml：AI 正在流式时显示等待动画', () => {
  state.streaming.add('ai2');
  const html = noteHtml({ id: 'ai2', paraIdx: 0, author: 'ai', type: 'aiask', quote: '但是', text: '问', answer: null, replies: [], time: '2026-11-20 10:00' }, null);
  assert.match(html, /AI 正在读这句话/);
  state.streaming.delete('ai2');
});

test('noteHtml：有答案时直接展示内容', () => {
  const html = noteHtml({ id: 'ai3', paraIdx: 0, author: 'ai', type: 'aiask', quote: '但是', text: '问', answer: '这是回答', replies: [], time: '2026-11-20 10:00' }, null);
  assert.match(html, /这是回答/);
});

test('noteHtml：长批注折叠为摘要 + 展开按钮', () => {
  const long = '很'.repeat(200);
  const html = noteHtml({ id: 'n5', paraIdx: 0, author: 'dad', type: 'kaodian', quote: '', text: long, replies: [], time: '2026-11-20 10:00' }, null);
  assert.match(html, /展开全文/);
  assert.equal(html.includes(long), false);
});

test('noteHtml：回复列表会渲染出每个回复', () => {
  const html = noteHtml({
    id: 'n6', paraIdx: 0, author: 'dad', type: 'kaodian', quote: '', text: '主体', time: '2026-11-20 10:00',
    replies: [{ id: 'r1', author: 'son', text: '回复内容', time: '2026-11-20 10:05' }]
  }, null);
  assert.match(html, /回复内容/);
  assert.match(html, /继续回复/);
});

test('chapterBodyHtml：只渲染已加载的段落，未加载的自动跳过', () => {
  useNotes([]);
  state.paras.clear();
  state.paras.set(0, { i: 0, ch: 0, text: P, kind: 'para' });
  state.paras.set(2, { i: 2, ch: 0, text: '第三段。', kind: 'para' });
  const html = chapterBodyHtml({ idx: 0, paraStart: 0, paraCount: 4 }, state.paras);
  assert.equal((html.match(/class="para-row"/g) || []).length, 2);
});

test('notesOfPara：返回按时间排序的批注', () => {
  useNotes([
    { id: 'b', paraIdx: 1, author: 'dad', time: '2026-11-20 11:00', replies: [] },
    { id: 'a', paraIdx: 1, author: 'son', time: '2026-11-20 10:00', replies: [] }
  ]);
  assert.deepEqual(notesOfPara(1).map((n) => n.id), ['a', 'b']);
});
