/* 问 AI：SSE 流式回答 + 客户端断开时中止上游 */
import express from 'express';
import { run, one } from '../db.js';
import { getNote, createNote } from '../library.js';
import { streamChat, readingMessages } from '../llm.js';
import { sseStart, wrapClient, HttpError } from '../http.js';
import { nowStr } from '../util.js';

const router = express.Router();

/**
 * 把回答流式写进 res，同时把完整结果落库。
 * 客户端中途断开：中止上游，且**不落库**（保留 null，用户可以重试），
 * 避免把半截回答当成最终答案。
 */
async function answerInto(req, res, note, question) {
  const para = one('SELECT text FROM paragraphs WHERE book_id = ? AND para_idx = ?', note.bookId, note.paraIdx);
  if (!para) throw new HttpError(400, '原文段落已被删除');
  const book = one('SELECT title FROM books WHERE id = ?', note.bookId);

  const ac = new AbortController();
  const sse = sseStart(req, res, () => ac.abort());
  sse.send({ type: 'start', note });

  let acc = '';
  try {
    const messages = readingMessages({
      bookTitle: book ? book.title : '',
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

    if (ac.signal.aborted) return;   // 中途断开：不写库，保持可重试

    if (!acc.trim()) {
      sse.send({ type: 'error', message: '模型没有返回内容，稍后再试一次' });
      return;
    }
    run('UPDATE notes SET answer = ?, updated_at = ? WHERE id = ?', acc, nowStr(), note.id);
    sse.send({ type: 'done', note: { ...note, answer: acc } });
  } catch (e) {
    if (ac.signal.aborted) return;
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
  // 不预先清空旧答案：失败时旧答案还能留着，成功后再覆盖
  await answerInto(req, res, note, note.text);
}));

export default router;
