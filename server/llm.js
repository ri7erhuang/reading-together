import { getSetting, run } from './db.js';
import { nowStr } from './util.js';

/* ============================================================
 * LLM 接入：全部在后端完成，前端只收流式文本。
 * 兼容 OpenAI Chat Completions 协议；没配 key 时回退到示例回答。
 * ============================================================ */

export function llmConfig() {
  const envKey = process.env.ZAI_API_KEY || process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY || '';
  const savedKey = getSetting('llm_key', '');
  const base = (getSetting('llm_base', '') ||
    (process.env.ZAI_API_KEY ? 'https://api.z.ai/api/paas/v4' : 'https://api.openai.com/v1')).replace(/\/+$/, '');
  const model = getSetting('llm_model', '') ||
    (process.env.ZAI_API_KEY ? 'glm-4.5-flash' : 'gpt-4o-mini');
  const key = savedKey || envKey;
  return {
    base, model, key,
    keySource: savedKey ? 'settings' : (envKey ? 'env' : 'none'),
    enabled: !!key
  };
}

export function publicLlmConfig() {
  const c = llmConfig();
  // 不向前端回传 key 的任何片段，只给「有没有配」和来源
  return { base: c.base, model: c.model, enabled: c.enabled, keySource: c.keySource };
}

async function* sseLines(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) yield line;
    }
  }
  if (buf.trim()) yield buf.trim();
}

export async function* streamChat({ messages, temperature = 0.6, maxTokens = 700, userId = '', purpose = 'ask', signal = null }) {
  const cfg = llmConfig();
  if (!cfg.enabled) {
    yield* mockStream(messages);
    return;
  }
  yield* realStream(cfg, messages, temperature, maxTokens, userId, purpose, signal);
}

/** 只有智谱系接口支持 thinking 字段，发给 OpenAI 等严格网关会直接 400 */
function supportsThinking(cfg) {
  return /z\.ai|bigmodel|zhipu/i.test(cfg.base || '') || /^glm/i.test(cfg.model || '');
}

async function* realStream(cfg, messages, temperature, maxTokens, userId, purpose, outerSignal) {
  const timeout = AbortSignal.timeout(120000);
  const signal = outerSignal && AbortSignal.any ? AbortSignal.any([timeout, outerSignal]) : timeout;
  const body = {
    model: cfg.model, messages, stream: true, temperature, max_tokens: maxTokens,
    stream_options: { include_usage: true }   // 没有它流式响应通常不回 usage，token 统计会一直是 0
  };
  if (supportsThinking(cfg)) body.thinking = { type: 'disabled' };
  const r = await fetch(cfg.base + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + cfg.key
    },
    body: JSON.stringify(body),
    signal
  });
  if (!r.ok || !r.body) {
    const detail = (await r.text().catch(() => '')).slice(0, 300);
    throw new Error('模型接口返回 ' + r.status + (detail ? '：' + detail : ''));
  }
  let usage = null;
  for await (const line of sseLines(r)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    let obj;
    try { obj = JSON.parse(data); } catch { continue; }
    if (obj.usage) usage = obj.usage;
    const delta = obj.choices?.[0]?.delta?.content || '';
    if (delta) yield delta;
  }
  if (usage) {
    run('INSERT INTO llm_calls(user_id, purpose, model, tokens_in, tokens_out, created_at) VALUES(?,?,?,?,?,?)',
      userId || '', purpose, cfg.model, usage.prompt_tokens || 0, usage.completion_tokens || 0, nowStr());
  }
  return true;
}

export async function chatOnce({ messages, temperature = 0.4, maxTokens = 500, userId = '', purpose = 'dict' }) {
  const cfg = llmConfig();
  if (!cfg.enabled) return null;
  const body = { model: cfg.model, messages, stream: false, temperature, max_tokens: maxTokens };
  if (supportsThinking(cfg)) body.thinking = { type: 'disabled' };
  const r = await fetch(cfg.base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000)
  });
  if (!r.ok) {
    const detail = (await r.text().catch(() => '')).slice(0, 300);
    throw new Error('模型接口返回 ' + r.status + (detail ? '：' + detail : ''));
  }
  const data = await r.json();
  const u = data.usage || {};
  run('INSERT INTO llm_calls(user_id, purpose, model, tokens_in, tokens_out, created_at) VALUES(?,?,?,?,?,?)',
    userId || '', purpose, cfg.model, u.prompt_tokens || 0, u.completion_tokens || 0, nowStr());
  return (data.choices?.[0]?.message?.content || '').trim();
}

export function readingMessages({ bookTitle, paraText, quote, question }) {
  const p = String(paraText || '').slice(0, 1600);
  return [
    {
      role: 'system',
      content: `你是一位耐心、口语化的初中语文老师，正在陪一对父子读《${bookTitle || '这本书'}》。` +
        '回答要基于给出的原文和上下文，不要编造情节；200 字以内，最多 3 个要点；' +
        '直接进入分析，不要寒暄、不要语气词、不要称呼对方，不要用 Markdown 标题，也不要复述问题。'
    },
    {
      role: 'user',
      content: `原文段落：${p}\n\n我划出的句子：${quote ? '「' + quote + '」' : '（整段）'}\n\n我的问题：${question}`
    }
  ];
}

/* ---------------- 没配 key 时的示例回答 ---------------- */

function mockText(question, quote) {
  const qq = quote ? '「' + String(quote).replace(/\n/g, ' ').slice(0, 26) + '」' : '这句话';
  if (/为什么|为何|怎么|咋|凭什么/.test(question)) {
    return qq + '出现在一个转折点上：前一段的情绪还在往上走，到这里被一句话按了下去。\n' +
      '答这类问题有个套路：先找「变化」——人物前后心情、动作、语气有什么不同；再找「开关」——是谁、哪句话把变化按下去的。\n' +
      '（这是示例回答：后台配置模型 key 之后，会自动换成真正的分析。）';
  }
  if (/意思|释义|解释|是什么|啥/.test(question)) {
    return qq + '字面上写的是眼前的物和事，但从上下文看，它同时在写「我」的心情：表面写景，实际写心。\n' +
      '把这句单独拎出来问自己：只按字面读，会漏掉什么？\n' +
      '（这是示例回答：后台配置模型 key 之后，会自动换成真正的释义与语境分析。）';
  }
  if (/考点|考试|怎么答|答题|作用|手法/.test(question)) {
    return qq + '可以这样答：先概括写了什么（内容），再点出手法（对比、欲扬先抑、细节描写等），最后落到情感或主题。\n' +
      '按「内容 → 手法 → 情感」三段写，考场上不容易漏点。\n' +
      '（这是示例回答：后台配置模型 key 之后，会结合具体问法给出答题要点。）';
  }
  return '好问题。' + qq + '值得停一停：把它放回整篇里看，它和开头、结尾各自是什么关系？\n' +
    '先自己写一句答案，再往下读——带着问题读，比读完再回忆有效得多。\n' +
    '（这是示例回答：后台配置模型 key 之后，会自动换成针对你问题的完整回答。）';
}

async function* mockStream(messages) {
  const userMsg = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
  const qm = /我的问题：([\s\S]*)$/.exec(userMsg);
  const qq = /我划出的句子：「([\s\S]*?)」/.exec(userMsg);
  const text = mockText(qm ? qm[1] : userMsg, qq ? qq[1] : '');
  for (const ch of text.match(/[\s\S]{1,6}/g) || []) {
    yield ch;
    await new Promise((r) => setTimeout(r, 28));
  }
}
