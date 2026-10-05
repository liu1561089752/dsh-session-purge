/**
 * HTTP plumbing for the plugin's own routes. `dsh-host-webserver` ships no
 * authentication or origin policy, so these handlers own it: loopback only,
 * same-origin only, JSON only, bounded bodies.
 * @module @local/dsh-session-purge/lib/http
 */
const MAX_BODY_BYTES = 16 * 1024;

/** Send one JSON response with the plugin's stable envelope. */
export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(body);
}

/** Success envelope. */
export function sendOk(res, value) {
  sendJson(res, 200, { ok: true, value });
}

/** Failure envelope. */
export function sendError(res, status, code, message, details) {
  sendJson(res, status, { ok: false, error: { code, message, ...(details ? { details } : {}) } });
}

/** 405 with the allowed method. */
export function sendMethodNotAllowed(res, allow) {
  res.setHeader('allow', allow);
  sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: `Use ${allow}` } });
}

/** Loopback detection for both IPv4 and IPv6 sockets. */
export function isLoopback(address) {
  if (typeof address !== 'string') return false;
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1' ||
    address.startsWith('127.')
  );
}

/**
 * Reject requests that no local same-origin page could have produced.
 * @returns `{ ok: true }` or `{ ok: false, status, code, message }`.
 */
export function checkTrust(req, config = {}) {
  const address = req.socket?.remoteAddress;
  if (config.allowNonLoopback !== true && !isLoopback(address)) {
    return { ok: false, status: 403, code: 'forbidden-origin', message: '仅允许本机访问' };
  }
  const host = req.headers?.host;
  const origin = req.headers?.origin;
  if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      return { ok: false, status: 403, code: 'forbidden-origin', message: 'Origin 无法解析' };
    }
    if (typeof host === 'string' && host !== '' && parsed.host !== host) {
      return { ok: false, status: 403, code: 'forbidden-origin', message: '跨站请求被拒绝' };
    }
  }
  const fetchSite = req.headers?.['sec-fetch-site'];
  if (typeof fetchSite === 'string' && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return { ok: false, status: 403, code: 'forbidden-origin', message: '跨站请求被拒绝' };
  }
  return { ok: true };
}

/** Read and parse a bounded JSON body. */
export async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      return { ok: false, status: 413, code: 'body-too-large', message: '请求体过大' };
    }
    chunks.push(chunk);
  }
  if (size === 0) return { ok: true, value: {} };
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, status: 400, code: 'invalid-body', message: '请求体必须是 JSON 对象' };
    }
    return { ok: true, value: parsed };
  } catch {
    return { ok: false, status: 400, code: 'invalid-body', message: '请求体不是合法 JSON' };
  }
}

/** Whether a value looks like a Harness session id. */
export function looksLikeSessionId(value) {
  return typeof value === 'string' && /^session-[A-Za-z0-9-]{1,64}$/.test(value);
}
