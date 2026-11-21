/* 阅读进度：按用户 + 书保存段落位置 */
import express from 'express';
import { getProgress, setProgress } from '../library.js';
import { HttpError } from '../http.js';

const router = express.Router();

router.get('/progress', (req, res) => {
  const bookId = String(req.query.bookId || '');
  if (!bookId) throw new HttpError(400, '缺少 bookId');
  res.json({ progress: getProgress(req.userId, bookId) });
});

router.post('/progress', (req, res) => {
  const { bookId, paraIdx } = req.body || {};
  if (!bookId) throw new HttpError(400, '缺少 bookId');
  setProgress(req.userId, String(bookId), Number(paraIdx) || 0);
  res.json({ ok: true });
});

export default router;
