import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { db, one, all, run, getSetting, setSetting, ROOT_DIR, EXPORT_DIR } from './db.js';
import { seed } from './seed.js';
import { parseTxt, parseEpub } from './importers.js';
import {
  createBook, deleteBook, listBooks, getBookBundle, notesOf, createNote, getNote, updateNote,
  deleteNote, addReply, deleteReply, getProgress, setProgress, buildExport, writeDailyExport,
  migrateLocal, chaptersOf, paragraphsOf
} from './library.js';
import { streamChat, chatOnce, readingMessages, publicLlmConfig, llmConfig } from './llm.js';
import { nowStr, todayStr } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DICT = JSON.parse(fs.readFileSync(path.join(__dirname, 'dict.json'), 'utf8'));
const PORT = Number(process.env.PORT || 8787);

seed();
try { writeDailyExport(); } catch (e) { console.error('备份失败：', e.message); }

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '4mb' }));

app.use((req, _res, next) => {
  const u = String(req.get('X-User') || '').trim();
  req.userId = u === 'son' ? 'son' : 'dad';
  next();
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ---------------- 基础信息 ---------------- */

app.get('/api/health', (_req, res) => res.json({ ok: true, time: nowStr() }));

app.get('/api/bootstrap', (req, res) => {
  const users = all('SELECT id, name, role FROM users ORDER BY CASE role WHEN \'dad\' THEN 0 ELSE 1 END');
  const books = listBooks().map((b) => {
    const n = one(
      `SELECT COUNT(*) AS total,
        SUM(CASE WHEN author='dad' THEN 1 ELSE 0 END) AS dad,
        SUM(CASE WHEN author='son' THEN 1 ELSE 0 END) AS son,
        SUM(CASE WHEN author='ai' THEN 1 ELSE 0 END) AS ai
       FROM notes WHERE book_id = ? AND deleted_at IS NULL`, b.id);
    return {
      ...b,
      counts: { total: n.total || 0, dad: n.dad || 0, son: n.son || 0, ai: n.ai || 0 },
      progress: getProgress(req.userId, b.id)
    };
  });
  const totals = one(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN author='dad' THEN 1 ELSE 0 END) AS dad,
      SUM(CASE WHEN author='son' THEN 1 ELSE 0 END) AS son,
      SUM(CASE WHEN author='ai' THEN 1 ELSE 0 END) AS ai
    FROM notes WHERE deleted_at IS NULL`);
  res.json({
    users, books, currentUserId: req.userId,
    totals: { total: totals.total || 0, dad: totals.dad || 0, son: totals.son || 0, ai: totals.ai || 0 },
    llm: publicLlmConfig()
  });
});

/* ---------------- 书籍 ---------------- */

app.get('/api/books', (_req, res) => res.json({ books: listBooks() }));

app.get('/api/books/:id', (req, res) => {
  const bundle = getBookBundle(req.params.id);
  if (!bundle) return res.status(404).json({ error: '这本书不存在' });
  res.json({ ...bundle, progress: getProgress(req.userId, req.params.id), llm: publicLlmConfig() });
});

app.get('/api/books/:id/notes', (req, res) => {
  if (!one('SELECT id FROM books WHERE id = ?', req.params.id)) return res.status(404).json({ error: '书不存在' });
  res.json({ notes: notesOf(req.params.id) });
});

const isZip = (buf) => buf && buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;

app.post('/api/books/import', express.raw({ type: () => true, limit: '200mb' }), wrap((req, res) => {
  const fileName = decodeURIComponent(String(req.get('X-Filename') || 'book.txt')).slice(0, 200);
  const titleHeader = decodeURIComponent(String(req.get('X-Title') || '')).trim();
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: '没有收到文件内容' });

  let parsed;
  if (/\.epub$/i.test(fileName) || isZip(buf)) {
    parsed = parseEpub(buf);
  } else {
    const fallback = titleHeader || fileName.replace(/\.[^.]+$/, '');
    parsed = parseTxt(buf.toString('utf8'), fallback);
  }
  if (titleHeader) parsed.title = titleHeader;
  if (!parsed.title) parsed.title = fileName.replace(/\.[^.]+$/, '');

  const maxOrder = one('SELECT COALESCE(MAX(order_idx), 0) AS m FROM books').m;
  const created = createBook(parsed, {
    sourceType: /\.epub$/i.test(fileName) || isZip(buf) ? 'epub' : 'txt',
    fileName,
    orderIdx: maxOrder + 1,
    tag: '导入'
  });
  res.json({ ok: true, ...created, chapters: parsed.chapters.length });
}));

app.delete('/api/books/:id', (req, res) => {
  const b = one('SELECT id, title FROM books WHERE id = ?', req.params.id);
  if (!b) return res.status(404).json({ error: '书不存在' });
  deleteBook(req.params.id);
  res.json({ ok: true });
});

/* ---------------- 批注 ---------------- */

app.post('/api/notes', wrap((req, res) => {
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

app.patch('/api/notes/:id', wrap((req, res) => {
  res.json({ note: updateNote(req.params.id, req.body || {}) });
}));

app.delete('/api/notes/:id', (req, res) => {
  if (!getNote(req.params.id)) return res.status(404).json({ error: '批注不存在' });
  deleteNote(req.params.id);
  res.json({ ok: true });
});

app.post('/api/notes/:id/replies', wrap((req, res) => {
  const reply = addReply(req.params.id, req.body?.author || req.userId, req.body?.text);
  res.json({ reply });
}));

app.delete('/api/replies/:id', (req, res) => {
  deleteReply(req.params.id);
  res.json({ ok: true });
});

/* ---------------- 进度 ---------------- */

app.get('/api/progress', (req, res) => {
  const bookId = String(req.query.bookId || '');
  res.json({ progress: getProgress(req.userId, bookId) });
});

app.post('/api/progress', (req, res) => {
  const { bookId, paraIdx } = req.body || {};
  if (!bookId) return res.status(400).json({ error: '缺少 bookId' });
  setProgress(req.userId, String(bookId), Number(paraIdx) || 0);
  res.json({ ok: true });
});

/* ---------------- 问 AI（SSE 流式） ---------------- */

function sseStart(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  return (obj) => {
    try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch {}
  };
}

async function answerInto(res, note, question) {
  const bundle = getBookBundle(note.bookId, false);
  const para = bundle && bundle.paras.find((p) => p.i === note.paraIdx);
  if (!para) throw new Error('原文段落已被删除');
  const send = sseStart(res);
  send({ type: 'start', note });
  let acc = '';
  try {
    const messages = readingMessages({
      bookTitle: bundle.book.title,
      paraText: para.text,
      quote: note.quote,
      question
    });
    for await (const delta of streamChat({ messages, userId: res.req.userId, purpose: 'ask' })) {
      acc += delta;
      send({ type: 'delta', text: delta });
    }
    if (!acc.trim()) acc = '（模型没有返回内容，稍后再试一次）';
    run('UPDATE notes SET answer = ?, updated_at = ? WHERE id = ?', acc, nowStr(), note.id);
    send({ type: 'done', note: { ...note, answer: acc } });
  } catch (e) {
    send({ type: 'error', message: String(e.message || e) });
  }
  res.end();
}

app.post('/api/ai/ask', wrap(async (req, res) => {
  const { bookId, paraIdx, quote, question } = req.body || {};
  const q = String(question || '').trim();
  if (!bookId || paraIdx == null || !q) return res.status(400).json({ error: '参数不完整' });
  if (q.length > 2000) return res.status(400).json({ error: '问题太长了' });
  const { note } = createNote({
    bookId, paraIdx, quote, author: 'ai', type: 'aiask', text: q, answer: null, source: 'AI'
  });
  await answerInto(res, note, q);
}));

app.post('/api/ai/retry/:id', wrap(async (req, res) => {
  const note = getNote(req.params.id);
  if (!note) return res.status(404).json({ error: '批注不存在' });
  run('UPDATE notes SET answer = NULL WHERE id = ?', note.id);
  await answerInto(res, note, note.text);
}));

/* ---------------- 查字词 ---------------- */

function cleanWord(s) {
  return String(s || '').replace(/[“”「」『』《》（）()、，。；：？！·\s"'…—]/g, '').trim();
}

const PINYIN_RE = /^[a-zA-ZüÜāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜńňǹ\s'·]+$/;

/** 模型偶尔不按行数输出，这里做兼容解析 */
function parseDictOutput(out, original) {
  const text = String(out || '').trim();
  if (!text) return { word: original, pinyin: '', def: '' };
  const block = text.split(/\n\s*\n/)[0];
  let lines = block.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!lines.length) return { word: original, pinyin: '', def: '' };

  const isPy = (s) => PINYIN_RE.test(s) && /[a-zü]/i.test(s) && s.length <= 40;
  let word = original, pinyin = '', def = '';

  if (isPy(lines[0])) {
    pinyin = lines[0];
    def = lines.slice(1).join(' ');
  } else if (lines.length >= 2 && isPy(lines[1])) {
    word = lines[0].replace(/[。：:]/g, '').trim();
    pinyin = lines[1];
    def = lines.slice(2).join(' ');
  } else {
    def = lines.join(' ');
  }

  if (def.length > 120) def = def.slice(0, 120) + '…';
  return { word: word || original, pinyin, def };
}

app.get('/api/dict', wrap(async (req, res) => {
  const raw = String(req.query.w || '');
  const w = cleanWord(raw);
  if (!w) return res.status(400).json({ error: '没有要查的字词' });

  if (DICT[w]) {
    return res.json({ word: w, pinyin: DICT[w][0], def: DICT[w][1], source: 'dict', exact: true });
  }
  let best = '';
  for (const k of Object.keys(DICT)) {
    if (w.includes(k) && k.length > best.length) best = k;
  }
  if (best) {
    return res.json({ word: best, pinyin: DICT[best][0], def: DICT[best][1], source: 'dict', exact: false, selected: raw });
  }

  const cached = one('SELECT * FROM dict_cache WHERE word = ?', w);
  if (cached) return res.json({ word: w, pinyin: cached.pinyin, def: cached.def, source: cached.source, exact: true });

  if (!llmConfig().enabled) return res.json({ word: w, found: false, source: 'none' });

  const out = await chatOnce({
    messages: [
      {
        role: 'system',
        content: '你是严谨的汉语词典。如果用户给的是一个词语，只输出两行：第一行拼音（带声调），第二行简洁释义（40 字内）。' +
          '如果用户给的是一句话，只输出三行：第一行是你挑出的、这句话里最不常见或最难懂的那个词，第二行它的拼音，第三行它的释义。' +
          '不要输出任何多余文字、例句或标点说明。'
      },
      { role: 'user', content: w }
    ],
    userId: req.userId, purpose: 'dict', maxTokens: 200
  });

  const parsed = parseDictOutput(out, w);
  if (!parsed.def) return res.json({ word: w, found: false, source: 'none' });
  run('INSERT INTO dict_cache(word, pinyin, def, source, created_at) VALUES(?,?,?,?,?) ON CONFLICT(word) DO NOTHING',
    parsed.word, parsed.pinyin, parsed.def, 'ai', nowStr());
  res.json({ word: parsed.word, pinyin: parsed.pinyin, def: parsed.def, source: 'ai', exact: parsed.word === w });
}));

/* ---------------- 用户 / 设置 / 管理 ---------------- */

app.patch('/api/users/:id', (req, res) => {
  const id = req.params.id === 'son' ? 'son' : 'dad';
  const name = String(req.body?.name || '').trim().slice(0, 30);
  if (!name) return res.status(400).json({ error: '昵称不能为空' });
  run('UPDATE users SET name = ? WHERE id = ?', name, id);
  res.json({ users: all('SELECT id, name, role FROM users') });
});

app.get('/api/settings', (_req, res) => {
  const files = fs.existsSync(EXPORT_DIR)
    ? fs.readdirSync(EXPORT_DIR).filter((f) => f.endsWith('.json')).sort().reverse().slice(0, 7)
    : [];
  res.json({ llm: publicLlmConfig(), backups: files, dataDir: EXPORT_DIR });
});

app.patch('/api/settings', (req, res) => {
  const b = req.body || {};
  if (b.clearKey) run("DELETE FROM settings WHERE key = 'llm_key'");
  if (typeof b.llm_key === 'string' && b.llm_key.trim() && !b.llm_key.startsWith('••••')) {
    setSetting('llm_key', b.llm_key.trim());
  }
  if (typeof b.llm_base === 'string') setSetting('llm_base', b.llm_base.trim());
  if (typeof b.llm_model === 'string') setSetting('llm_model', b.llm_model.trim());
  res.json({ llm: publicLlmConfig() });
});

app.post('/api/llm/test', wrap(async (req, res) => {
  if (!llmConfig().enabled) return res.json({ ok: false, message: '还没有配置 API Key' });
  try {
    const t0 = Date.now();
    const out = await chatOnce({
      messages: [{ role: 'user', content: '只回复两个字：可用' }],
      userId: req.userId, purpose: 'test', maxTokens: 20
    });
    res.json({ ok: true, message: out || '(空)', ms: Date.now() - t0, model: llmConfig().model });
  } catch (e) {
    res.json({ ok: false, message: String(e.message || e) });
  }
}));

app.get('/api/admin/notes', (req, res) => {
  const where = ['n.deleted_at IS NULL'];
  const args = [];
  if (req.query.bookId) { where.push('n.book_id = ?'); args.push(String(req.query.bookId)); }
  if (req.query.author) { where.push('n.author = ?'); args.push(String(req.query.author)); }
  const rows = all(`SELECT n.*, b.title AS book_title FROM notes n JOIN books b ON b.id = n.book_id
    WHERE ${where.join(' AND ')} ORDER BY n.created_at DESC LIMIT 1000`, ...args);
  res.json({
    notes: rows.map((r) => ({
      id: r.id, bookId: r.book_id, bookTitle: r.book_title, paraIdx: r.para_idx, quote: r.quote,
      author: r.author, type: r.type, text: r.text, answer: r.answer, source: r.source,
      time: r.created_at, anchorOk: !r.quote || r.offset != null
    }))
  });
});

/* ---------------- 备份 / 迁移 ---------------- */

app.get('/api/export', (_req, res) => {
  const data = buildExport();
  const name = 'reading-together-' + todayStr().replace(/-/g, '') + '.json';
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="' + name + '"');
  res.send(JSON.stringify(data, null, 2));
});

app.post('/api/backup/now', (_req, res) => {
  const file = writeDailyExport();
  res.json({ ok: true, file: path.basename(file) });
});

app.post('/api/migrate-local', (req, res) => {
  const result = migrateLocal(req.body || {});
  res.json({ ok: true, ...result });
});

/* ---------------- 静态前端 ---------------- */

const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
app.use(express.static(PUBLIC_DIR, {
  maxAge: 0,
  setHeaders: (res, file) => { res.setHeader('Cache-Control', 'no-cache'); }
}));
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.use((err, _req, res, _next) => {
  console.error(err);
  if (res.headersSent) return res.end();
  res.status(500).json({ error: String(err.message || err) });
});

setInterval(() => {
  try { writeDailyExport(); } catch (e) { console.error('备份失败：', e.message); }
}, 6 * 3600 * 1000).unref();

app.listen(PORT, '0.0.0.0', () => {
  const cfg = llmConfig();
  console.log(`[reading-together] http://0.0.0.0:${PORT}`);
  console.log(`[reading-together] LLM: ${cfg.enabled ? cfg.model + ' (' + cfg.keySource + ')' : '未配置，使用示例回答'}`);
  console.log(`[reading-together] 数据目录: ${path.join(ROOT_DIR, 'data')}`);
});
