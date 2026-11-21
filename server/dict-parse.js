/* 模型输出解析：把「拼音/释义」类的自由文本拆成字段
 * 单独成文件是为了能写测试——模型输出不稳定，这里必须容错。 */

const PINYIN_RE = /^[a-zA-ZüÜāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜńňǹ\s'·]+$/;

function isPinyinLine(s) {
  const t = String(s || '').trim();
  if (!t || t.length > 40) return false;
  return PINYIN_RE.test(t) && /[a-zü]/i.test(t);
}

/** 去掉模型爱加的「词语：」「拼音：」「释义：」前缀 */
function stripLabel(s) {
  return String(s || '').replace(/^[^：:]{1,6}[：:]\s*/, '').trim();
}

/**
 * 期望两种形状：
 *   两行：拼音 / 释义
 *   三行：词语 / 拼音 / 释义
 * 其它情况尽量兜住：带标签的、拼音夹在中间的、多段输出只取第一段。
 */
export function parseDictOutput(out, original) {
  const text = String(out || '').trim();
  if (!text) return { word: original, pinyin: '', def: '' };

  const block = text.split(/\n\s*\n/)[0];
  const lines = block.split('\n').map((s) => stripLabel(s)).filter(Boolean);
  if (!lines.length) return { word: original, pinyin: '', def: '' };

  let word = original;
  let pinyin = '';
  let def = '';

  // 先在各行里找拼音行（可能是第 1 行或第 2 行）
  let pyIdx = lines.findIndex((l, i) => i < 2 && isPinyinLine(l));
  if (pyIdx >= 0) {
    pinyin = lines[pyIdx];
    if (pyIdx === 1) word = lines[0].replace(/[。：:]/g, '').trim() || original;
    def = lines.slice(pyIdx + 1).join(' ');
  } else {
    def = lines.join(' ');
  }

  // 释义里如果混进了拼音行（模型重复输出），去掉
  if (def && pinyin) def = def.replace(pinyin, '').trim();

  if (def.length > 120) def = def.slice(0, 120) + '…';
  return { word: word || original, pinyin, def };
}

export const __test = { isPinyinLine, stripLabel };
