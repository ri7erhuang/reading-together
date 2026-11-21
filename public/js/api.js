export const session = {
  userId: localStorage.getItem('rtz_user') === 'son' ? 'son' : 'dad'
};

export function setUser(id) {
  session.userId = id === 'son' ? 'son' : 'dad';
  localStorage.setItem('rtz_user', session.userId);
}

async function parseError(res) {
  try {
    const j = await res.json();
    return j.error || ('请求失败 ' + res.status);
  } catch {
    return '请求失败 ' + res.status;
  }
}

export async function api(path, opts = {}) {
  const headers = Object.assign({ 'X-User': session.userId }, opts.headers || {});
  const init = { method: opts.method || 'GET', headers };
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, init);
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function uploadBook(file, title) {
  const headers = {
    'X-User': session.userId,
    'X-Filename': encodeURIComponent(file.name),
    'Content-Type': 'application/octet-stream'
  };
  if (title) headers['X-Title'] = encodeURIComponent(title);
  const res = await fetch('/api/books/import', {
    method: 'POST', headers, body: await file.arrayBuffer()
  });
  if (res.status === 409) {
    const j = await res.json().catch(() => ({}));
    const err = new Error(j.error || '这本书已经在书架上了');
    err.duplicate = j.duplicate || null;
    throw err;
  }
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

/**
 * 读取服务端 SSE 流：onStart / onDelta / onDone / onError。
 * 返回 { abort, promise }：abort 可随时中止（离开页面、切书时用），promise 用于等结束。
 */
export function streamSSE(path, body, handlers = {}) {
  const ctrl = new AbortController();

  const promise = (async () => {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User': session.userId },
      body: JSON.stringify(body || {}),
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error(await parseError(res));
    if (!res.body) throw new Error('浏览器不支持流式响应');

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let finished = false;

    const dispatch = (chunk) => {
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (!raw) continue;
        let ev;
        try { ev = JSON.parse(raw); } catch { continue; }
        if (ev.type === 'start' && handlers.onStart) handlers.onStart(ev.note);
        else if (ev.type === 'delta' && handlers.onDelta) handlers.onDelta(ev.text);
        else if (ev.type === 'done') { finished = true; handlers.onDone && handlers.onDone(ev.note); }
        else if (ev.type === 'error') { finished = true; handlers.onError && handlers.onError(ev.message || '出错了'); }
      }
    };

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        dispatch(chunk);
      }
    }
    if (buf.trim()) dispatch(buf);
    if (!finished) handlers.onError && handlers.onError('连接中断了，可以点重试');
  })();

  return { abort: () => ctrl.abort(), promise };
}

export async function downloadExport() {
  const res = await fetch('/api/export', { headers: { 'X-User': session.userId } });
  if (!res.ok) throw new Error(await parseError(res));
  const blob = await res.blob();
  const name = 'reading-together-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '.json';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}
