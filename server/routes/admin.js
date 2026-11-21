/* 管理接口：启动数据、设置、模型测试、批注总览、导出、备份、旧数据迁移 */
import express from 'express';
import fs from 'node:fs';
import { all, one, run, setSetting, EXPORT_DIR } from '../db.js';
import { listBooks, getProgress, buildExport, writeDailyExport, migrateLocal } from '../library.js';
import { chatOnce, llmConfig, publicLlmConfig } from '../llm.js';
import { wrap, wrapClient, HttpError } from '../http.js';
import { todayStr } from '../util.js';

const router = express.Router();

const NOTE_COUNTS = `SELECT COUNT(*) AS total,
    SUM(CASE WHEN author='dad' THEN 1 ELSE 0 END) AS dad,
    SUM(CASE WHEN author='son' THEN 1 ELSE 0 END) AS son,
    SUM(CASE WHEN author='ai' THEN 1 ELSE 0 END) AS ai
  FROM notes WHERE deleted_at IS NULL`;

router.get('/bootstrap', (req, res) => {
  const users = all("SELECT id, name, role FROM users ORDER BY CASE role WHEN 'dad' THEN 0 ELSE 1 END");
  const books = listBooks().map((b) => {
    const n = one(NOTE_COUNTS + ' AND book_id = ?', b.id);
    return {
      ...b,
      counts: { total: n.total || 0, dad: n.dad || 0, son: n.son || 0, ai: n.ai || 0 },
      progress: getProgress(req.userId, b.id)
    };
  });
  const totals = one(NOTE_COUNTS);
  res.json({
    users, books, currentUserId: req.userId,
    totals: { total: totals.total || 0, dad: totals.dad || 0, son: totals.son || 0, ai: totals.ai || 0 },
    llm: publicLlmConfig()
  });
});

router.patch('/users/:id', (req, res) => {
  const id = req.params.id === 'son' ? 'son' : 'dad';
  const name = String(req.body?.name || '').trim().slice(0, 30);
  if (!name) throw new HttpError(400, '昵称不能为空');
  run('UPDATE users SET name = ? WHERE id = ?', name, id);
  res.json({ users: all('SELECT id, name, role FROM users') });
});

router.get('/settings', (_req, res) => {
  const files = fs.existsSync(EXPORT_DIR)
    ? fs.readdirSync(EXPORT_DIR).filter((f) => f.endsWith('.json')).sort().reverse().slice(0, 7)
    : [];
  res.json({ llm: publicLlmConfig(), backups: files, dataDir: EXPORT_DIR });
});

router.patch('/settings', (req, res) => {
  const b = req.body || {};
  if (b.clearKey) run("DELETE FROM settings WHERE key = 'llm_key'");
  if (typeof b.llm_key === 'string' && b.llm_key.trim() && !b.llm_key.startsWith('••••')) {
    setSetting('llm_key', b.llm_key.trim());
  }
  if (typeof b.llm_base === 'string') setSetting('llm_base', b.llm_base.trim());
  if (typeof b.llm_model === 'string') setSetting('llm_model', b.llm_model.trim());
  res.json({ llm: publicLlmConfig() });
});

router.post('/llm/test', wrap(async (req, res) => {
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

router.get('/admin/notes', (req, res) => {
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

router.get('/export', (_req, res) => {
  const data = buildExport();
  const name = 'reading-together-' + todayStr().replace(/-/g, '') + '.json';
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="' + name + '"');
  res.send(JSON.stringify(data, null, 2));
});

router.post('/backup/now', wrap(async (_req, res) => {
  const file = await writeDailyExport();
  res.json({ ok: true, file: String(file).split(/[\\/]/).pop() });
}));

router.post('/migrate-local', wrapClient((req, res) => {
  res.json({ ok: true, ...migrateLocal(req.body || {}) });
}));

export default router;
