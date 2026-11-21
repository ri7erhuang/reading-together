/* 查字词：内置词表 → 缓存 → 模型 */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { one, run } from '../db.js';
import { chatOnce, llmConfig } from '../llm.js';
import { parseDictOutput } from '../dict-parse.js';
import { nowStr } from '../util.js';
import { wrap, HttpError } from '../http.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DICT = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dict.json'), 'utf8'));

const router = express.Router();

function cleanWord(s) {
  return String(s || '').replace(/[“”「」『』《》（）()、，。；：？！·\s"'…—]/g, '').trim();
}

router.get('/dict', wrap(async (req, res) => {
  const raw = String(req.query.w || '');
  const w = cleanWord(raw);
  if (!w) throw new HttpError(400, '没有要查的字词');
  if (w.length > 40) throw new HttpError(400, '一次最多查 40 个字');

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

export default router;
