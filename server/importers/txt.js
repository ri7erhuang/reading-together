/* TXT 解析：识别章节、按排版切分段落、超长段落按句末切分 */

const CN_NUM = '[一二三四五六七八九十百千零〇两\\d]';

const CHAPTER_PATTERNS = [
  new RegExp('^第' + CN_NUM + '+[章节回卷篇部集]'),
  /^(序章|序言|自序|前言|后记|尾声|楔子|引子|附录|番外)/,
  /^(chapter|part|book)\s+[\divxlc]+/i,
  new RegExp('^' + CN_NUM + '+[、.．]'),
  /^\d{1,3}[、.．]/,
  /^[（(][一二三四五六七八九十\d]+[)）]/
];

const CHAPTER_MAX_LEN = 60;
const PARA_MAX = 900;

function isChapterLine(line) {
  const t = String(line).trim();
  if (!t || t.length > CHAPTER_MAX_LEN) return false;
  // 「一、」这类编号后面必须跟文字，纯数字行不算章节
  if (/^\d+$/.test(t)) return false;
  return CHAPTER_PATTERNS.some((re) => re.test(t));
}

/**
 * 超长段落切分：优先在句末标点处断，找不到就往后延一段再找，最后才硬切。
 * 避免从句子中间截断导致「摘录定位」失效。
 */
function splitLongBlock(text, max = PARA_MAX) {
  if (text.length <= max) return [text];
  const out = [];
  let rest = text;
  const breaks = '。！？；…';
  while (rest.length > max) {
    let cut = -1;
    for (let i = max; i > max * 0.5; i--) {
      if (breaks.includes(rest[i - 1])) { cut = i; break; }
    }
    if (cut < 0) {
      // 前 450 字内没有句末标点，继续往后找，最多到 1.5 倍长度
      const beyond = Math.min(rest.length, Math.floor(max * 1.5));
      for (let i = max; i < beyond; i++) {
        if (breaks.includes(rest[i - 1])) { cut = i; break; }
      }
    }
    if (cut < 0) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut);
  }
  if (rest.trim()) out.push(rest.trim());
  return out;
}

export function parseTxt(rawText, fallbackTitle = '未命名') {
  let text = String(rawText)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '');

  const lines = text.split('\n');
  const blankLines = lines.reduce((n, l) => n + (l.trim() ? 0 : 1), 0);
  const blocksMode = blankLines >= 3; // 常见排版：段落之间空行

  const chapters = [];
  let current = { title: '正文', paras: [] };

  const pushPara = (t) => {
    const clean = String(t).replace(/[ \t\u3000]+$/g, '').trim();
    if (!clean) return;
    for (const piece of splitLongBlock(clean)) current.paras.push({ text: piece, kind: 'para' });
  };
  const pushChapter = (title) => {
    if (current.paras.length) chapters.push(current);
    current = { title: title || '正文', paras: [] };
  };

  if (blocksMode) {
    let block = [];
    const flush = () => {
      if (!block.length) return;
      const indented = block.filter((l) => /^(\u3000|[ \t]{2,})/.test(l)).length;
      if (block.length > 2 && indented >= block.length * 0.5) {
        block.forEach((l) => {
          if (isChapterLine(l)) pushChapter(l.trim());
          else pushPara(l.replace(/^(\u3000|[ \t]{2,})/, ''));
        });
      } else {
        const joined = block.map((l) => l.trim()).filter(Boolean).join('');
        if (isChapterLine(joined)) pushChapter(joined);
        else pushPara(joined);
      }
      block = [];
    };
    for (const line of lines) {
      if (!line.trim()) { flush(); continue; }
      block.push(line);
    }
    flush();
  } else {
    for (const line of lines) {
      if (!line.trim()) continue;
      if (isChapterLine(line)) pushChapter(line.trim());
      else pushPara(line.replace(/^(\u3000|[ \t]{2,})/, ''));
    }
  }

  if (current.paras.length) chapters.push(current);
  const usable = chapters.filter((c) => c.paras.length);
  if (!usable.length) throw new Error('这个 txt 里没有解析出正文，换个文件试试');

  // 只有一节且没识别到章节名时，用首段开头给个提示性标题
  if (usable.length === 1 && usable[0].title === '正文') {
    const head = usable[0].paras[0].text.replace(/\s/g, '').slice(0, 16);
    if (head) usable[0].title = '正文 · ' + head + (usable[0].paras[0].text.length > 16 ? '…' : '');
  }
  return { title: fallbackTitle, author: '', chapters: usable };
}

export const __test = { isChapterLine, splitLongBlock };
