/* 批注与回复 */
import express from 'express';
import { one } from '../db.js';
import { notesOf, createNote, getNote, updateNote, deleteNote, addReply, deleteReply } from '../library.js';
import { wrapClient, HttpError } from '../http.js';

const router = express.Router();

router.get('/books/:id/notes', (req, res) => {
  if (!one('SELECT id FROM books WHERE id = ?', req.params.id)) throw new HttpError(404, '书不存在');
  res.json({ notes: notesOf(req.params.id) });
});

router.post('/notes', wrapClient((req, res) => {
  const body = req.body || {};
  const out = createNote({
    bookId: body.bookId,
    paraIdx: body.paraIdx,
    quote: body.quote,
    author: body.author || req.userId,
    type: body.type,
    text: body.text,
    source: body.source || '网页录入'
  });
  res.json(out);
}));

router.patch('/notes/:id', wrapClient((req, res) => {
  res.json({ note: updateNote(req.params.id, req.body || {}) });
}));

router.delete('/notes/:id', (req, res) => {
  if (!getNote(req.params.id)) throw new HttpError(404, '批注不存在');
  deleteNote(req.params.id);
  res.json({ ok: true });
});

router.post('/notes/:id/replies', wrapClient((req, res) => {
  const reply = addReply(req.params.id, req.body?.author || req.userId, req.body?.text);
  res.json({ reply });
}));

router.delete('/replies/:id', (req, res) => {
  deleteReply(req.params.id);
  res.json({ ok: true });
});

export default router;
