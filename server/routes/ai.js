/* 问 AI：SSE 流式回答 + 客户端断开时中止上游 */
import express from 'express';
import { run } from '../db.js';
import { getBookBundle, getNote, createNote } from '../library.js';
import { streamChat, readingMessages } from '../llm.js';
import { sseStart, wrapClient, HttpError } from '../http.js';
import { nowStr } from '../util.js';

const router = express.Router();

/**
 * 把回答流式写进 res，同时把完整结果落库。
 * 客户端中途断开时：中止上游请求，并把已生成的部分保存下来（可重试续写）。
 */
async function answerInto(req, res, note, question) {
  const bundle = getBookBundle(note.bookId, false);
  const para = bundle && bundle.paras.find((p) => p.i === note.paraIdx);
  if (!para) throw new HttpError(400, '原文段落已被删除');

  const ac = new AbortController();
  const sse = sseStart(req, res, () => ac.abort());
  sse.send({ type: 'start', note });

  let acc = '';
  try {
    const messages = readingMessages({
      bookTitle: bundle.book.title,
      paraText: para.text,
      quote: note.quote,
      question
    });
    for await (const delta of streamChat({
      messages, userId: req.userId, purpose: 'ask', signal: ac.signal
    })) {
      acc += delta;
      if (!sse.send({ type: 'delta', text: delta })) break; // 写不出去说明客户端走了
    }

    if (!acc.trim()) acc = '（模型没有返回内容，稍后再试一次）';
    run('UPDATE notes SET answer = ?, updated_at = ? WHERE id = ?', acc, nowStr(), note.id);
    sse.send({ type: 'done', note: { ...note, answer: acc } });
  } catch (e) {
    if (ac.signal.aborted) {
      // 用户离开了页面：保留已生成的内容，下次可以重试补充
      if (acc.trim()) {
        run('UPDATE notes SET answer = ?, updated_at = ? WHERE id = ?', acc, nowStr(), note.id);
      }
      return;
    }
    sse.send({ type: 'error', message: String(e.message || e) });
  } finally {
    sse.close();
  }
}

router.post('/ai/ask', wrapClient(async (req, res) => {
  const { bookId, paraIdx, quote, question } = req.body || {};
  const q = String(question || '').trim();
  if (!bookId || paraIdx == null || !q) throw new HttpError(400, '参数不完整');
  if (q.length > 2000) throw new HttpError(400, '问题太长了（2000 字以内）');

  const { note } = createNote({
    bookId, paraIdx, quote, author: 'ai', type: 'aiask', text: q, answer: null, source: 'AI'
  });
  await answerInto(req, res, note, q);
}));

router.post('/ai/retry/:id', wrapClient(async (req, res) => {
  const note = getNote(req.params.id);
  if (!note) throw new HttpError(404, '批注不存在');
  run('UPDATE notes SET answer = NULL WHERE id = ?', note.id);
  await answerInto(req, res, { ...note, answer: null }, note.text);
}));

export default router;
