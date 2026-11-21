import { db, one, all, run, tx, EXPORT_DIR } from './db.js';
import { uid, sha1, nowStr, todayStr, locateQuote } from './util.js';
import fs from 'node:fs';
import path from 'node:path';

/* ---------------- 书籍 ---------------- */

export function createBook(parsed, opts = {}) {
  const id = opts.id || 'bk_' + sha1(String(parsed.title) + Date.now() + Math.random()).slice(0, 10);
  const createdAt = opts.createdAt || nowStr();
  return tx(() => {
    run(`INSERT INTO books(id, title, author, source_type, file_name, tag, meta, order_idx, created_at)
         VALUES(?,?,?,?,?,?,?,?,?)`,
      id, String(parsed.title || '未命名').slice(0, 200), String(parsed.author || ''),
      opts.sourceType || 'txt', opts.fileName || '', opts.tag || '',
      JSON.stringify(opts.meta || {}), opts.orderIdx ?? 0, createdAt);

    let paraIdx = 0;
    parsed.chapters.forEach((ch, ci) => {
      const start = paraIdx;
      const title = String(ch.title || ('第 ' + (ci + 1) + ' 节')).slice(0, 120);
      run(`INSERT INTO chapters(book_id, idx, title, para_start, para_count, legacy_key)
           VALUES(?,?,?,?,?,?)`,
        id, ci, title, start, ch.paras.length, ch.legacyKey || null);
      for (const p of ch.paras) {
        const text = String(typeof p === 'string' ? p : p.text);
        run('INSERT INTO paragraphs(book_id, para_idx, chapter_idx, text, hash, kind) VALUES(?,?,?,?,?,?)',
          id, paraIdx, ci, text, sha1(text).slice(0, 16), (typeof p === 'object' && p.kind) || 'para');
        paraIdx++;
      }
    });
    return { id, title: parsed.title, paraCount: paraIdx };
  });
}

export function deleteBook(bookId) {
  return tx(() => {
    run('DELETE FROM replies WHERE note_id IN (SELECT id FROM notes WHERE book_id = ?)', bookId);
    run('DELETE FROM notes WHERE book_id = ?', bookId);
    run('DELETE FROM paragraphs WHERE book_id = ?', bookId);
    run('DELETE FROM chapters WHERE book_id = ?', bookId);
    run('DELETE FROM progress WHERE book_id = ?', bookId);
    run('DELETE FROM books WHERE id = ?', bookId);
  });
}

export function listBooks() {
  return all(`SELECT b.*,
      (SELECT COUNT(*) FROM notes n WHERE n.book_id = b.id AND n.deleted_at IS NULL) AS note_count,
      (SELECT COUNT(*) FROM paragraphs p WHERE p.book_id = b.id) AS para_count,
      (SELECT COUNT(*) FROM chapters c WHERE c.book_id = b.id) AS chapter_count
    FROM books b ORDER BY b.order_idx ASC, b.created_at ASC`).map((b) => ({
    id: b.id, title: b.title, author: b.author, sourceType: b.source_type,
    fileName: b.file_name, tag: b.tag, meta: safeJson(b.meta),
    orderIdx: b.order_idx, createdAt: b.created_at,
    noteCount: b.note_count, paraCount: b.para_count, chapterCount: b.chapter_count
  }));
}

function safeJson(s) {
  try { return JSON.parse(s || '{}'); } catch { return {}; }
}

export function chaptersOf(bookId) {
  return all('SELECT * FROM chapters WHERE book_id = ? ORDER BY idx', bookId).map((c) => ({
    idx: c.idx, title: c.title, paraStart: c.para_start, paraCount: c.para_count, legacyKey: c.legacy_key
  }));
}

export function paragraphsOf(bookId) {
  return all('SELECT para_idx, chapter_idx, text, hash, kind FROM paragraphs WHERE book_id = ? ORDER BY para_idx', bookId)
    .map((p) => ({ i: p.para_idx, ch: p.chapter_idx, text: p.text, hash: p.hash, kind: p.kind }));
}

export function noteRow(r, replies) {
  return {
    id: r.id, bookId: r.book_id, paraIdx: r.para_idx, quote: r.quote || '',
    offset: r.offset, qlen: r.qlen, author: r.author, type: r.type, text: r.text,
    answer: r.answer, source: r.source, time: r.created_at, replies: replies || []
  };
}

export function notesOf(bookId) {
  const rows = all('SELECT * FROM notes WHERE book_id = ? AND deleted_at IS NULL ORDER BY created_at ASC', bookId);
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const marks = ids.map(() => '?').join(',');
  const reps = all(`SELECT * FROM replies WHERE note_id IN (${marks}) AND deleted_at IS NULL ORDER BY created_at ASC`, ...ids);
  const byNote = new Map();
  reps.forEach((r) => {
    if (!byNote.has(r.note_id)) byNote.set(r.note_id, []);
    byNote.get(r.note_id).push({ id: r.id, author: r.author, text: r.text, time: r.created_at });
  });
  return rows.map((r) => noteRow(r, byNote.get(r.id) || []));
}

export function getBookBundle(bookId, withNotes = true) {
  const b = one('SELECT * FROM books WHERE id = ?', bookId);
  if (!b) return null;
  return {
    book: {
      id: b.id, title: b.title, author: b.author, sourceType: b.source_type,
      fileName: b.file_name, tag: b.tag, meta: safeJson(b.meta), createdAt: b.created_at
    },
    chapters: chaptersOf(bookId),
    paras: paragraphsOf(bookId),
    notes: withNotes ? notesOf(bookId) : []
  };
}

/* ---------------- 批注 ---------------- */

const NOTE_TYPES = new Set(['tucao', 'question', 'kaodian', 'brilliant', 'aiask']);
const AUTHORS = new Set(['dad', 'son', 'ai']);

export function createNote(input) {
  const bookId = String(input.bookId || '');
  const paraIdx = Number(input.paraIdx);
  const text = String(input.text || '').trim();
  const author = AUTHORS.has(input.author) ? input.author : 'dad';
  const type = NOTE_TYPES.has(input.type) ? input.type : 'kaodian';
  if (!text) throw new Error('批注内容不能为空');
  if (text.length > 8000) throw new Error('批注太长了');

  const p = one('SELECT text, hash FROM paragraphs WHERE book_id = ? AND para_idx = ?', bookId, paraIdx);
  if (!p) throw new Error('找不到对应的段落');
  const quote = String(input.quote || '').trim();
  const loc = quote ? locateQuote(p.text, quote) : null;

  const id = input.id || uid('dm');
  const time = input.time || nowStr();
  run(`INSERT INTO notes(id, book_id, para_idx, para_hash, quote, offset, qlen, author, type, text, answer, source, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, bookId, paraIdx, p.hash, quote, loc ? loc.offset : null, loc ? loc.len : null,
    author, type, text,
    input.answer === undefined ? null : input.answer,
    input.source || '网页录入', time, time);

  return { note: getNote(id), warning: quote && !loc ? '摘录没有在原文中定位到，批注会挂在段落旁但不做划词高亮' : '' };
}

export function getNote(id) {
  const r = one('SELECT * FROM notes WHERE id = ?', id);
  if (!r) return null;
  const reps = all('SELECT * FROM replies WHERE note_id = ? AND deleted_at IS NULL ORDER BY created_at', id)
    .map((x) => ({ id: x.id, author: x.author, text: x.text, time: x.created_at }));
  return noteRow(r, reps);
}

export function updateNote(id, patch) {
  const r = one('SELECT * FROM notes WHERE id = ?', id);
  if (!r) throw new Error('批注不存在');
  const text = patch.text != null ? String(patch.text).trim() : r.text;
  const type = patch.type && NOTE_TYPES.has(patch.type) ? patch.type : r.type;
  let quote = patch.quote != null ? String(patch.quote).trim() : r.quote;
  let offset = r.offset, qlen = r.qlen;
  if (patch.quote != null) {
    const p = one('SELECT text FROM paragraphs WHERE book_id = ? AND para_idx = ?', r.book_id, r.para_idx);
    const loc = p && quote ? locateQuote(p.text, quote) : null;
    offset = loc ? loc.offset : null;
    qlen = loc ? loc.len : null;
  }
  if (patch.paraIdx != null && Number(patch.paraIdx) !== r.para_idx) {
    const p = one('SELECT text, hash FROM paragraphs WHERE book_id = ? AND para_idx = ?', r.book_id, Number(patch.paraIdx));
    if (!p) throw new Error('目标段落不存在');
    const loc = quote ? locateQuote(p.text, quote) : null;
    run('UPDATE notes SET para_idx=?, para_hash=?, quote=?, offset=?, qlen=?, text=?, type=?, updated_at=? WHERE id=?',
      Number(patch.paraIdx), p.hash, quote, loc ? loc.offset : null, loc ? loc.len : null, text, type, nowStr(), id);
    return getNote(id);
  }
  run('UPDATE notes SET quote=?, offset=?, qlen=?, text=?, type=?, updated_at=? WHERE id=?',
    quote, offset, qlen, text, type, nowStr(), id);
  return getNote(id);
}

export function deleteNote(id) {
  run('UPDATE notes SET deleted_at = ? WHERE id = ?', nowStr(), id);
}

export function addReply(noteId, author, text) {
  if (!one('SELECT id FROM notes WHERE id = ? AND deleted_at IS NULL', noteId)) throw new Error('批注不存在');
  const t = String(text || '').trim();
  if (!t) throw new Error('回复不能为空');
  if (t.length > 4000) throw new Error('回复太长了');
  const id = uid('rp');
  run('INSERT INTO replies(id, note_id, author, text, created_at) VALUES(?,?,?,?,?)',
    id, noteId, AUTHORS.has(author) ? author : 'dad', t, nowStr());
  return { id, author, text: t, time: nowStr() };
}

export function deleteReply(id) {
  run('UPDATE replies SET deleted_at = ? WHERE id = ?', nowStr(), id);
}

/* ---------------- 进度 ---------------- */

export function getProgress(userId, bookId) {
  const r = one('SELECT para_idx, updated_at FROM progress WHERE user_id = ? AND book_id = ?', userId, bookId);
  return r ? { paraIdx: r.para_idx, updatedAt: r.updated_at } : null;
}

export function setProgress(userId, bookId, paraIdx) {
  run(`INSERT INTO progress(user_id, book_id, para_idx, updated_at) VALUES(?,?,?,?)
       ON CONFLICT(user_id, book_id) DO UPDATE SET para_idx = excluded.para_idx, updated_at = excluded.updated_at`,
    userId, bookId, Number(paraIdx) || 0, nowStr());
}

/* ---------------- 导出 / 备份 ---------------- */

export function buildExport() {
  const users = all('SELECT id, name, role FROM users ORDER BY role DESC');
  const books = listBooks().map((b) => {
    const bundle = getBookBundle(b.id);
    return {
      id: b.id, title: b.title, author: b.author, sourceType: b.sourceType,
      fileName: b.fileName, tag: b.tag, meta: b.meta, createdAt: b.createdAt,
      chapters: bundle.chapters.map((c) => ({
        title: c.title,
        paras: bundle.paras.slice(c.paraStart, c.paraStart + c.paraCount).map((p) => p.text)
      })),
      notes: bundle.notes
    };
  });
  return {
    app: 'reading-together',
    version: 2,
    exported: nowStr(),
    users,
    books
  };
}

export function writeDailyExport() {
  const file = path.join(EXPORT_DIR, 'archive-' + todayStr() + '.json');
  if (fs.existsSync(file)) return file;
  fs.writeFileSync(file, JSON.stringify(buildExport(), null, 2));
  const files = fs.readdirSync(EXPORT_DIR).filter((f) => /^archive-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  while (files.length > 30) {
    const old = files.shift();
    try { fs.unlinkSync(path.join(EXPORT_DIR, old)); } catch {}
  }
  return file;
}

/* ---------------- 旧 localStorage 迁移 ---------------- */

export function migrateLocal(payload) {
  const builtin = one("SELECT id FROM books WHERE json_extract(meta, '$.builtin') = 1");
  const bookId = payload.bookId || (builtin && builtin.id);
  const result = { notes: 0, replies: 0, hidden: 0, skipped: 0, names: false };

  if (payload.names && typeof payload.names === 'object') {
    for (const key of ['dad', 'son']) {
      const name = String(payload.names[key] || '').trim();
      if (name) run('UPDATE users SET name = ? WHERE id = ?', name.slice(0, 30), key);
    }
    result.names = true;
  }

  if (bookId) {
    const chapters = chaptersOf(bookId);
    const byLegacy = new Map(chapters.filter((c) => c.legacyKey).map((c) => [c.legacyKey, c]));

    if (Array.isArray(payload.local)) {
      for (const n of payload.local) {
        if (!n || !n.id || !n.text) continue;
        if (one('SELECT id FROM notes WHERE id = ?', n.id)) { result.skipped++; continue; }
        const ch = byLegacy.get(n.essay);
        if (!ch) { result.skipped++; continue; }
        const paraIdx = ch.paraStart + (Number(n.para) || 0);
        if (!one('SELECT 1 AS ok FROM paragraphs WHERE book_id = ? AND para_idx = ?', bookId, paraIdx)) {
          result.skipped++; continue;
        }
        try {
          createNote({
            id: n.id, bookId, paraIdx, quote: n.quote || '', author: n.author,
            type: n.type, text: n.text, answer: n.answer === undefined ? null : n.answer,
            source: n.source || '本地导入', time: n.time
          });
          result.notes++;
        } catch { result.skipped++; }
      }
    }

    if (payload.replies && typeof payload.replies === 'object') {
      for (const [noteId, list] of Object.entries(payload.replies)) {
        if (!Array.isArray(list)) continue;
        for (const r of list) {
          if (!r || !r.text) continue;
          if (one('SELECT id FROM replies WHERE id = ?', r.id)) continue;
          if (!one('SELECT id FROM notes WHERE id = ?', noteId)) continue;
          run('INSERT INTO replies(id, note_id, author, text, created_at) VALUES(?,?,?,?,?)',
            r.id || uid('rp'), noteId, r.author === 'son' ? 'son' : 'dad', String(r.text),
            r.time || nowStr());
          result.replies++;
        }
      }
    }

    if (Array.isArray(payload.hidden)) {
      for (const id of payload.hidden) {
        if (!id) continue;
        const existed = one('SELECT id FROM notes WHERE id = ? AND deleted_at IS NULL', String(id));
        if (existed) {
          run('UPDATE notes SET deleted_at = ? WHERE id = ?', nowStr(), String(id));
          result.hidden++;
        }
      }
    }
  }
  return result;
}
