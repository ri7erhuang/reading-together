/* 服务入口：只负责装配（中间件、路由、静态资源、错误处理、定时任务） */
import express from 'express';
import path from 'node:path';
import { ROOT_DIR } from './db.js';
import { seed } from './seed.js';
import { writeDailyExport } from './library.js';
import { nowStr } from './util.js';
import { HttpError } from './http.js';

import booksRouter from './routes/books.js';
import notesRouter from './routes/notes.js';
import progressRouter from './routes/progress.js';
import aiRouter from './routes/ai.js';
import dictRouter from './routes/dict.js';
import adminRouter from './routes/admin.js';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0'; // 家里局域网用 0.0.0.0；只在本机用可设 HOST=127.0.0.1

seed();
writeDailyExport().catch((e) => console.error('备份失败：', e.message));

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '4mb' }));

/** 身份只用于「谁写的批注」，不是鉴权：这个服务假定运行在可信的家庭网络内 */
app.use((req, _res, next) => {
  const u = String(req.get('X-User') || '').trim();
  req.userId = u === 'son' ? 'son' : 'dad';
  next();
});

app.get('/api/health', (_req, res) => res.json({ ok: true, time: nowStr(), version: 2 }));

app.use('/api', booksRouter, notesRouter, progressRouter, aiRouter, dictRouter, adminRouter);

/* ---------------- 静态前端 ---------------- */

const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
app.use(express.static(PUBLIC_DIR, {
  index: false,
  // 一律协商缓存：改了文件立刻可见，没改则走 304 省流量
  setHeaders: (res) => { res.setHeader('Cache-Control', 'no-cache'); }
}));
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
  // 带扩展名的资源找不到时应当 404；回退成 index.html 会让浏览器把 HTML 当 JS 解析
  if (path.extname(req.path)) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

/* ---------------- 错误处理 ---------------- */

app.use((err, _req, res, _next) => {
  const status = err instanceof HttpError ? err.status : (err.status || 500);
  if (status >= 500) console.error(err);
  if (res.headersSent) return res.end();
  res.status(status).json({ error: String(err.message || err) });
});

setInterval(() => {
  writeDailyExport().catch((e) => console.error('备份失败：', e.message));
}, 6 * 3600 * 1000).unref();

app.listen(PORT, HOST, () => {
  console.log(`[reading-together] http://${HOST}:${PORT}`);
  console.log(`[reading-together] 数据目录: ${path.join(ROOT_DIR, 'data')}`);
});
