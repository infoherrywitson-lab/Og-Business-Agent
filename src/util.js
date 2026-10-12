/**
 * Shared HTTP utilities: responses, body parsing, cookies, errors.
 */

/** Application error carrying an HTTP status and a safe client message. */
export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   * @param {Record<string, string>} [headers]
   */
  constructor(status, message, headers = {}) {
    super(message);
    this.name = 'HttpError';
    /** @type {number} */
    this.status = status;
    /** @type {Record<string, string>} */
    this.headers = headers;
  }
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 * @param {Record<string, string>} [headers]
 */
export function sendJson(res, status, body, headers = {}) {
  if (res.writableEnded || res.destroyed) return;
  const payload = JSON.stringify(body);
  const isHead = Boolean(res.req && res.req.method === 'HEAD');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(payload)),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isHead ? undefined : payload);
}

/**
 * Read and parse a JSON request body with a hard size limit.
 * @param {import('node:http').IncomingMessage} req
 * @param {number} limitBytes
 * @returns {Promise<Record<string, any>>}
 */
export async function readJsonBody(req, limitBytes) {
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > limitBytes) {
      throw new HttpError(413, 'Request body too large', { Connection: 'close' });
    }
    chunks.push(buf);
  }
  if (size === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }
  return /** @type {Record<string, any>} */ (parsed);
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {Record<string, string>}
 */
export function parseCookies(req) {
  /** @type {Record<string, string>} */
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

/**
 * Resolve the client IP, honouring X-Forwarded-For only when trusted.
 * @param {import('node:http').IncomingMessage} req
 * @param {boolean} trustProxy
 * @returns {string}
 */
export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    const first = (Array.isArray(fwd) ? fwd[0] : fwd || '').split(',')[0].trim();
    if (first) return first.slice(0, 64);
  }
  return (req.socket.remoteAddress || 'unknown').slice(0, 64);
}

/**
 * True when the request arrived over HTTPS (directly or via a trusted proxy).
 * @param {import('node:http').IncomingMessage} req
 * @param {boolean} trustProxy
 */
export function isHttps(req, trustProxy) {
  if (req.socket && /** @type {any} */ (req.socket).encrypted) return true;
  if (trustProxy) {
    const proto = req.headers['x-forwarded-proto'];
    const value = (Array.isArray(proto) ? proto[0] : proto || '').split(',')[0].trim();
    if (value === 'https') return true;
  }
  return false;
}

/**
 * Reject cross-site browser requests (CSRF defence; non-browser clients such
 * as curl do not send Origin and are allowed through).
 * @param {import('node:http').IncomingMessage} req
 */
export function isSameOrigin(req) {
  const site = req.headers['sec-fetch-site'];
  if (site && !Array.isArray(site) && ['cross-site'].includes(site)) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  if (origin === 'null') return false;
  try {
    const parsed = new URL(origin);
    return parsed.host === (req.headers.host || '');
  } catch {
    return false;
  }
}

/**
 * Validate a post-login redirect target: local path only, no open redirects.
 * @param {unknown} value
 * @returns {string}
 */
export function safeReturnTo(value) {
  if (typeof value !== 'string') return '/app';
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/app';
  return value.slice(0, 512);
}

/**
 * Trim and bound a user-supplied string.
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
export function safeText(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/**
 * Require a non-empty string within bounds, otherwise throw a 400.
 * @param {unknown} value
 * @param {{min?: number, max: number, label: string}} opts
 * @returns {string}
 */
export function requireString(value, opts) {
  const text = typeof value === 'string' ? value.trim() : '';
  const min = opts.min ?? 1;
  if (text.length < min) {
    throw new HttpError(400, `${opts.label} must be at least ${min} character${min === 1 ? '' : 's'}.`);
  }
  if (text.length > opts.max) {
    throw new HttpError(400, `${opts.label} must be at most ${opts.max} characters.`);
  }
  return text;
}
