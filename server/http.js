/* HTTP 层公共工具：错误包装、SSE 通道、请求头解码 */

/** 把 async 路由的异常交给 Express 错误中间件 */
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * 业务校验失败（空内容、找不到段落等）默认按 400 返回，
 * 避免把「用户输入问题」当成 500 服务器错误。
 */
export const wrapClient = (fn) => wrap(async (req, res) => {
  try {
    return await fn(req, res);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, e.message || '操作失败');
  }
});

/** 业务错误：带 HTTP 状态码，供中间件统一输出 */
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * HTTP 头只允许 latin1，客户端发来的 UTF-8 中文会被逐字节解码成乱码。
 * 这里尝试按 latin1 取回原始字节，再用 UTF-8 严格解码修复。
 */
function repairLatin1(s) {
  if (!/[\u0080-\u00ff]/.test(s)) return s;
  try {
    const buf = Buffer.from(s, 'latin1');
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    if (decoded && !decoded.includes('\uFFFD')) return decoded;
  } catch {}
  return s;
}

/**
 * 请求头里的中文/文件名需要先解码。
 * 客户端偶尔发出非法 % 序列，decodeURIComponent 会抛 URIError，这里降级为原串。
 */
export function headerText(req, name, fallback = '') {
  const raw = req.get(name);
  if (raw == null) return fallback;
  let out = String(raw);
  try { out = decodeURIComponent(out); } catch {}
  return repairLatin1(out);
}

/**
 * 打开一条 SSE 通道。
 * onClose：客户端断开时回调（用于中止上游请求）；
 * 返回 { send, close, aborted }。
 */
export function sseStart(req, res, onClose) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  let closed = false;
  const markClosed = () => {
    if (closed) return;
    closed = true;
    try { onClose && onClose(); } catch {}
  };
  // 注意：req 的 'close' 在请求体读完后就会触发（Node 16+ 语义），
  // 不能用来判断客户端断开；用 res 的 'close' + writableEnded 区分「正常结束」和「中途断开」。
  res.on('close', () => {
    if (!res.writableEnded) markClosed();
  });
  const send = (obj) => {
    if (closed) return false;
    try {
      res.write('data: ' + JSON.stringify(obj) + '\n\n');
      return true;
    } catch {
      markClosed();
      return false;
    }
  };
  return { send, close: () => { try { res.end(); } catch {} }, aborted: () => closed };
}

/** 解析 query 里的整数，非法值退回默认值 */
export function intParam(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}
