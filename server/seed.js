import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { one, run, tx, ROOT_DIR } from './db.js';
import { createBook } from './library.js';
import { nowStr } from './util.js';

/* 内置《朝花夕拾》：首次启动时把 seed/texts.js 灌进数据库（只灌书，不带示例批注） */
const ORDER = [
  ['wuchanghui', '五猖会'],
  ['baicaoyuan', '从百草园到三味书屋'],
  ['achang', '阿长与《山海经》'],
  ['wuchang', '无常'],
  ['fudebing', '父亲的病'],
  ['suoji', '琐记'],
  ['tengye', '藤野先生'],
  ['fanainong', '范爱农'],
  ['xiaoyin', '小引'],
  ['ershisi', '二十四孝图'],
  ['goumaoshu', '狗·猫·鼠'],
  ['houji', '后记']
];

const SEED_DIR = path.join(ROOT_DIR, 'seed');

function loadWindowScript(file, key) {
  const code = fs.readFileSync(path.join(SEED_DIR, file), 'utf8');
  const sandbox = { window: {} };
  vm.runInNewContext(code, sandbox, { timeout: 10000 });
  return sandbox.window[key];
}

export function seed() {
  return tx(() => {
    if (!one('SELECT id FROM users LIMIT 1')) {
      run("INSERT INTO users(id, name, role, created_at) VALUES('dad','爸爸','dad',?)", nowStr());
      run("INSERT INTO users(id, name, role, created_at) VALUES('son','儿子','son',?)", nowStr());
    }

    const existing = one("SELECT id, title FROM books WHERE json_extract(meta, '$.builtin') = 1");
    if (existing) return { seeded: false, bookId: existing.id };

    const texts = loadWindowScript('texts.js', 'ESSAY_TEXTS');
    if (!texts) return { seeded: false };

    const chapters = ORDER.filter(([k]) => texts[k]).map(([k, fallbackTitle]) => {
      const t = texts[k];
      return {
        title: t.title || fallbackTitle,
        legacyKey: k,
        paras: t.paras.map((p) => ({ text: p.t, kind: p.sign ? 'sign' : 'para' }))
      };
    });

    const created = createBook(
      { title: '朝花夕拾', author: '鲁迅', chapters },
      {
        id: 'bk_zhaohuaxishi',
        sourceType: 'builtin',
        tag: '内置书 · 公版全文',
        orderIdx: 0,
        meta: { builtin: true, language: 'zh', order: ORDER.map(([k, t]) => ({ k, t })) }
      }
    );
    return { seeded: true, bookId: created.id };
  });
}
