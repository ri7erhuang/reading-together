/* 书架与书籍：列表、元信息、分章段落、导入、删除 */
import express from 'express';
import { one } from '../db.js';
import {
  createBook, deleteBook, listBooks, getBookMeta, getBookBundle, parasOfChapter,
  findDuplicateBook, getProgress, chaptersOf
} from '../library.js';
import { parseBook } from '../importers/index.js';
import { wrap, headerText, HttpError, intParam } from '../http.js';

const router = express.Router();

router.get('/books', (_req, res) => res.json({ books: listBooks() }));

/**
 * 默认只返回书信息 + 章节 + 批注，段落按章懒加载（大书首屏才快）。
 * ?full=1 返回全部段落，供需要一次性读取的场景使用。
 */
router.get('/books/:id', (req, res) => {
  const meta = getBookMeta(req.params.id, true);
  if (!meta) throw new HttpError(404, '这本书不存在');
  const progress = getProgress(req.userId, req.params.id);
  if (req.query.full === '1') {
    const bundle = getBookBundle(req.params.id, true);
    return res.json({ ...bundle, progress });
  }
  res.json({ ...meta, progress });
});

router.get('/books/:id/chapters/:idx/paras', (req, res) => {
  const idx = intParam(req.params.idx, -1);
  const ch = one('SELECT idx, title, para_start, para_count FROM chapters WHERE book_id = ? AND idx = ?',
    req.params.id, idx);
  if (!ch) throw new HttpError(404, '章节不存在');
  res.json({
    chapter: { idx: ch.idx, title: ch.title, paraStart: ch.para_start, paraCount: ch.para_count },
    paras: parasOfChapter(req.params.id, idx)
  });
});

router.get('/books/:id/chapters', (req, res) => {
  if (!one('SELECT id FROM books WHERE id = ?', req.params.id)) throw new HttpError(404, '书不存在');
  res.json({ chapters: chaptersOf(req.params.id) });
});

/** 导入 txt / epub：原始字节直传，服务端判断格式与编码 */
router.post('/books/import', express.raw({ type: () => true, limit: '200mb' }), wrap((req, res) => {
  const fileName = headerText(req, 'X-Filename', 'book.txt').slice(0, 200);
  const titleHint = headerText(req, 'X-Title', '').trim().slice(0, 200);
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) throw new HttpError(400, '没有收到文件内容');

  const { parsed, sourceType } = parseBook(buf, fileName, titleHint);
  const dup = findDuplicateBook(parsed);
  if (dup && req.query.force !== '1') {
    return res.status(409).json({
      error: '这本书已经在书架上了：' + dup.title + '（如需再导一份，加 ?force=1）',
      duplicate: { id: dup.id, title: dup.title }
    });
  }

  const maxOrder = one('SELECT COALESCE(MAX(order_idx), 0) AS m FROM books').m;
  const created = createBook(parsed, {
    sourceType,
    fileName,
    orderIdx: maxOrder + 1,
    tag: '导入'
  });
  res.json({ ok: true, ...created, chapters: parsed.chapters.length, sourceType });
}));

router.delete('/books/:id', (req, res) => {
  const b = one('SELECT id, title FROM books WHERE id = ?', req.params.id);
  if (!b) throw new HttpError(404, '书不存在');
  deleteBook(req.params.id);
  res.json({ ok: true });
});

export default router;
