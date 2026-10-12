/**
 * Business OS server: HTTP routing, authentication, API, static delivery.
 *
 * Security posture:
 *  - SameSite=Lax HttpOnly session cookies; only SHA-256 hashes are stored.
 *  - scrypt password hashing, failed-login lockout, per-IP rate limits.
 *  - CSRF defence via Origin/Sec-Fetch-Site checks on every mutation.
 *  - Strict CSP without 'unsafe-inline'; all UI scripts/styles are files.
 *  - Whitelisted static extensions with path-containment checks.
 *  - RBAC: viewer < member < admin, enforced on every mutating route.
 *  - Every state change lands in the audit log with the acting user.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createStore } from './store.js';
import { createPlan } from './planner.js';
import {
  hashPassword,
  verifyPassword,
  createSessionToken,
  hashToken,
  isValidEmail,
  passwordProblem,
  roleAtLeast,
} from './auth.js';
import {
  HttpError,
  sendJson,
  readJsonBody,
  parseCookies,
  clientIp,
  isSameOrigin,
  isHttps,
  safeReturnTo,
  safeText,
  requireString,
} from './util.js';
import { applySecurityHeaders, createRateLimiter, rateHeaders, createLoginGuard } from './security.js';

const SESSION_COOKIE = 'bos_session';
const VERSION = readVersion();
const STATIC_EXT = new Set(['.html', '.css', '.js', '.svg', '.png', '.jpg', '.webp', '.ico', '.txt', '.webmanifest']);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};
const TASK_STATUSES = new Set(['queued', 'in_progress', 'completed', 'blocked']);
const ROLES = new Set(['admin', 'member', 'viewer']);

function readVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * @param {import('./types.js').User} user
 */
function publicUser(user) {
  return { id: user.id, email: user.email, name: user.name, role: user.role, createdAt: user.createdAt, lastLoginAt: user.lastLoginAt };
}

/**
 * @param {string} token
 * @param {number} maxAgeMs
 * @param {boolean} secure
 */
function sessionCookie(token, maxAgeMs, secure) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Max-Age=${Math.floor(maxAgeMs / 1000)}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/**
 * @param {boolean} secure
 */
function clearCookie(secure) {
  return `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/**
 * Create the HTTP server. Takes injected dependencies so tests can run an
 * isolated instance on a temp data directory and an ephemeral port.
 *
 * @param {{config: import('./types.js').AppConfig, store: import('./store.js').Store, logger?: import('./types.js').Logger}} deps
 * @returns {http.Server}
 */
export function createServer(deps) {
  const { config, store } = deps;
  const logger = deps.logger || createLogger('info');

  const rateGlobal = createRateLimiter({ windowMs: config.rate.windowMs, max: config.rate.max });
  const rateAuth = createRateLimiter({ windowMs: config.rate.authWindowMs, max: config.rate.authMax });
  const ratePlan = createRateLimiter({ windowMs: config.rate.planWindowMs, max: config.rate.planMax });
  const loginGuard = createLoginGuard();

  /**
   * Resolve the current request's session, if any.
   * @param {http.IncomingMessage} req
   * @returns {{user: import('./types.js').User, tokenHash: string}|null}
   */
  function authenticate(req) {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (!token) return null;
    const tokenHash = hashToken(token);
    const session = store.findSession(tokenHash);
    if (!session) return null;
    if (Date.parse(session.expiresAt) <= Date.now()) {
      store.deleteSession(tokenHash);
      return null;
    }
    const user = store.getUserById(session.userId);
    if (!user || !user.active) return null;
    if (Date.now() - Date.parse(session.lastSeenAt) > 5 * 60_000) {
      store.touchSession(tokenHash, config.sessionTtlMs);
    }
    return { user, tokenHash };
  }

  /**
   * @param {http.IncomingMessage} req
   * @param {import('./types.js').Role} required
   * @returns {{user: import('./types.js').User, tokenHash: string}}
   */
  function requireRole(req, required) {
    const auth = authenticate(req);
    if (!auth) throw new HttpError(401, 'Authentication required.');
    if (!roleAtLeast(auth.user.role, required)) {
      throw new HttpError(403, `This action requires the ${required} role.`);
    }
    return auth;
  }

  /**
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   * @param {URL} url
   * @param {string} method
   * @param {string} ip
   */
  async function handleApi(req, res, url, method, ip) {
    const p = url.pathname;

    if (p === '/api/health' && method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        service: 'Business OS',
        version: VERSION,
        mode: config.env,
        aiConfigured: Boolean(config.ai.apiKey),
        externalActionsEnabled: false,
        uptimeSec: Math.round(process.uptime()),
      });
    }

    if (p === '/api/auth/state' && method === 'GET') {
      return sendJson(res, 200, { setupRequired: store.countUsers() === 0 });
    }

    if (p === '/api/auth/setup' && method === 'POST') {
      const limit = rateAuth(ip);
      if (!limit.allowed) return sendJson(res, 429, { error: 'Too many attempts. Try again later.' }, rateHeaders(limit));
      if (store.countUsers() > 0) throw new HttpError(403, 'This workspace has already been set up.');
      const input = await readJsonBody(req, config.bodyLimitBytes);
      const email = requireString(input.email, { max: 254, label: 'Email' }).toLowerCase();
      if (!isValidEmail(email)) throw new HttpError(400, 'Enter a valid email address.');
      const name = requireString(input.name, { min: 2, max: 120, label: 'Name' });
      const problem = passwordProblem(input.password);
      if (problem) throw new HttpError(400, problem);
      const passwordHash = await hashPassword(String(input.password));
      const user = store.createUser({ email, name, role: 'admin', passwordHash });
      store.logAudit('auth.setup', user.id, { email }, { id: user.id, label: user.email });
      const { token, tokenHash } = createSessionToken();
      store.createSession({ tokenHash, userId: user.id, ip, ttlMs: config.sessionTtlMs });
      res.setHeader('Set-Cookie', sessionCookie(token, config.sessionTtlMs, isHttps(req, config.trustProxy)));
      return sendJson(res, 201, { user: publicUser(user) });
    }

    if (p === '/api/auth/login' && method === 'POST') {
      const limit = rateAuth(ip);
      if (!limit.allowed) return sendJson(res, 429, { error: 'Too many attempts. Try again later.' }, rateHeaders(limit));
      const input = await readJsonBody(req, config.bodyLimitBytes);
      const email = requireString(input.email, { max: 254, label: 'Email' }).toLowerCase();
      const password = typeof input.password === 'string' ? input.password : '';
      const guardKey = `${ip}|${email}`;
      const lockedFor = loginGuard.lockedFor(guardKey);
      if (lockedFor > 0) {
        return sendJson(res, 429, { error: 'Too many failed sign-in attempts. Try again later.' }, { 'Retry-After': String(lockedFor) });
      }
      const user = store.getUserByEmail(email);
      const ok = Boolean(user && user.active && password && (await verifyPassword(password, user.passwordHash)));
      if (!ok || !user) {
        loginGuard.fail(guardKey);
        store.logAudit('auth.login_failed', email, { ip }, { id: 'anonymous', label: email });
        return sendJson(res, 401, { error: 'Invalid email or password.' });
      }
      loginGuard.succeed(guardKey);
      store.markLogin(user.id);
      const { token, tokenHash } = createSessionToken();
      store.createSession({ tokenHash, userId: user.id, ip, ttlMs: config.sessionTtlMs });
      store.logAudit('auth.login', user.id, { ip }, { id: user.id, label: user.email });
      res.setHeader('Set-Cookie', sessionCookie(token, config.sessionTtlMs, isHttps(req, config.trustProxy)));
      return sendJson(res, 200, { user: publicUser(user) });
    }

    if (p === '/api/auth/logout' && method === 'POST') {
      const auth = authenticate(req);
      if (auth) {
        store.deleteSession(auth.tokenHash);
        store.logAudit('auth.logout', auth.user.id, {}, { id: auth.user.id, label: auth.user.email });
      }
      res.setHeader('Set-Cookie', clearCookie(isHttps(req, config.trustProxy)));
      return sendJson(res, 200, { ok: true });
    }

    const auth = authenticate(req);
    if (!auth) throw new HttpError(401, 'Authentication required.');
    const actor = { id: auth.user.id, label: auth.user.email, role: auth.user.role };

    if (p === '/api/me' && method === 'GET') {
      return sendJson(res, 200, { user: publicUser(auth.user) });
    }

    if (p === '/api/stats' && method === 'GET') {
      return sendJson(res, 200, store.getStats());
    }

    if (p === '/api/audit' && method === 'GET') {
      const rawLimit = Number.parseInt(url.searchParams.get('limit') || '100', 10);
      const limit = Number.isNaN(rawLimit) ? 100 : Math.min(Math.max(rawLimit, 1), 500);
      return sendJson(res, 200, { events: store.listAudit(limit) });
    }

    // --- team administration (admin only) ---------------------------------
    if (p === '/api/users' && method === 'GET') {
      requireRole(req, 'admin');
      return sendJson(res, 200, { users: store.listUsers().map(publicUser) });
    }
    if (p === '/api/users' && method === 'POST') {
      const { user: admin } = requireRole(req, 'admin');
      const input = await readJsonBody(req, config.bodyLimitBytes);
      const email = requireString(input.email, { max: 254, label: 'Email' }).toLowerCase();
      if (!isValidEmail(email)) throw new HttpError(400, 'Enter a valid email address.');
      const name = requireString(input.name, { min: 2, max: 120, label: 'Name' });
      const role = String(input.role || 'member');
      if (!ROLES.has(role)) throw new HttpError(400, 'Role must be admin, member or viewer.');
      const problem = passwordProblem(input.password);
      if (problem) throw new HttpError(400, problem);
      if (store.getUserByEmail(email)) throw new HttpError(409, 'A user with that email already exists.');
      const passwordHash = await hashPassword(String(input.password));
      const created = store.createUser({ email, name, role: /** @type {import('./types.js').Role} */ (role), passwordHash });
      logger.info('user.created', { actor: admin.email, email, role });
      return sendJson(res, 201, { user: publicUser(created) });
    }
    const userMatch = p.match(/^\/api\/users\/([^/]+)$/);
    if (userMatch && method === 'PATCH') {
      const { user: admin } = requireRole(req, 'admin');
      const target = store.getUserById(decodeURIComponent(userMatch[1]));
      if (!target) throw new HttpError(404, 'User not found.');
      const input = await readJsonBody(req, config.bodyLimitBytes);
      /** @type {{name?: string, role?: import('./types.js').Role, active?: boolean, passwordHash?: string}} */
      const patch = {};
      if (input.role !== undefined) {
        const role = String(input.role);
        if (!ROLES.has(role)) throw new HttpError(400, 'Role must be admin, member or viewer.');
        patch.role = /** @type {import('./types.js').Role} */ (role);
      }
      if (input.active !== undefined) patch.active = Boolean(input.active);
      if (input.name !== undefined) patch.name = requireString(input.name, { min: 2, max: 120, label: 'Name' });
      if (input.password !== undefined) {
        const problem = passwordProblem(input.password);
        if (problem) throw new HttpError(400, problem);
        patch.passwordHash = await hashPassword(String(input.password));
      }
      const losesAdmin = target.role === 'admin' && target.active && (
        (patch.role !== undefined && patch.role !== 'admin') || patch.active === false
      );
      if (losesAdmin) {
        const otherAdmins = store.listUsers().filter((u) => u.id !== target.id && u.role === 'admin' && u.active);
        if (otherAdmins.length === 0) throw new HttpError(409, 'The workspace must keep at least one active admin.');
      }
      const updated = store.updateUser(target.id, patch);
      if (!updated) throw new HttpError(404, 'User not found.');
      logger.info('user.updated', { actor: admin.email, target: updated.email });
      return sendJson(res, 200, { user: publicUser(updated) });
    }

    // --- projects ----------------------------------------------------------
    if (p === '/api/projects' && method === 'GET') {
      return sendJson(res, 200, { projects: store.listProjects() });
    }
    if (p === '/api/projects' && method === 'POST') {
      const { user } = requireRole(req, 'member');
      const limit = ratePlan(user.id);
      if (!limit.allowed) return sendJson(res, 429, { error: 'Plan creation rate limit reached. Try again in a moment.' }, rateHeaders(limit));
      const input = await readJsonBody(req, config.bodyLimitBytes);
      const prompt = requireString(input.prompt, { min: 8, max: 10_000, label: 'Project brief' });
      const name = safeText(input.name, 120);
      const plan = await createPlan(prompt, name || 'New project', config.ai);
      const project = store.createProject(plan, prompt, { id: user.id, label: user.email, role: user.role });
      logger.info('project.created', { id: project.id, tasks: project.tasks.length, ai: plan.planningMode });
      return sendJson(res, 201, { project });
    }
    const projectMatch = p.match(/^\/api\/projects\/([^/]+)$/);
    if (projectMatch && method === 'GET') {
      const project = store.getProject(decodeURIComponent(projectMatch[1]));
      if (!project) throw new HttpError(404, 'Project not found.');
      return sendJson(res, 200, { project });
    }
    if (projectMatch && method === 'DELETE') {
      const { user } = requireRole(req, 'admin');
      const removed = store.deleteProject(decodeURIComponent(projectMatch[1]), { id: user.id, label: user.email });
      if (!removed) throw new HttpError(404, 'Project not found.');
      return sendJson(res, 200, { ok: true });
    }
    const taskMatch = p.match(/^\/api\/projects\/([^/]+)\/tasks\/([^/]+)$/);
    if (taskMatch && method === 'PATCH') {
      const { user } = requireRole(req, 'member');
      const input = await readJsonBody(req, config.bodyLimitBytes);
      /** @type {{status?: import('./types.js').TaskStatus, output?: string|null}} */
      const patch = {};
      if (input.status !== undefined) {
        const status = String(input.status);
        if (!TASK_STATUSES.has(status)) throw new HttpError(400, 'Invalid task status.');
        patch.status = /** @type {import('./types.js').TaskStatus} */ (status);
      }
      if (input.output !== undefined) patch.output = input.output === null ? null : safeText(input.output, 4000) || null;
      if (patch.status === undefined && patch.output === undefined) throw new HttpError(400, 'Nothing to update.');
      const task = store.updateTask(decodeURIComponent(taskMatch[1]), decodeURIComponent(taskMatch[2]), patch);
      if (!task) throw new HttpError(404, 'Task not found.');
      store.logAudit('task.updated', task.id, { status: task.status, project: task.projectId }, { id: user.id, label: user.email });
      return sendJson(res, 200, { task });
    }

    // --- approvals ---------------------------------------------------------
    if (p === '/api/approvals' && method === 'GET') {
      return sendJson(res, 200, { approvals: store.listApprovals() });
    }
    const approvalMatch = p.match(/^\/api\/approvals\/([^/]+)$/);
    if (approvalMatch && method === 'POST') {
      const { user } = requireRole(req, 'admin');
      const input = await readJsonBody(req, config.bodyLimitBytes);
      const decision = String(input.decision || '');
      if (decision !== 'approved' && decision !== 'rejected') {
        throw new HttpError(400, 'Decision must be approved or rejected.');
      }
      const note = safeText(input.note, 500);
      try {
        const approval = store.decideApproval(decodeURIComponent(approvalMatch[1]), decision, note, { id: user.id, label: user.email, role: user.role });
        if (!approval) throw new HttpError(404, 'Approval not found.');
        return sendJson(res, 200, { approval });
      } catch (err) {
        if (err instanceof HttpError) throw err;
        const status = /** @type {any} */ (err).status;
        if (status === 409) throw new HttpError(409, err instanceof Error ? err.message : 'Conflict');
        throw err;
      }
    }

    throw new HttpError(404, 'API route not found.');
  }

  /**
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   * @param {URL} url
   * @param {string} method
   * @returns {Promise<void>}
   */
  async function handleStatic(req, res, url, method) {
    if (method !== 'GET' && method !== 'HEAD') {
      return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET, HEAD' });
    }
    let pathname = url.pathname;
    /** @type {string|null} */
    let redirect = null;

    if (pathname === '/' || pathname === '/index.html') pathname = '/index.html';
    else if (pathname === '/auth' || pathname === '/auth/') pathname = '/auth.html';
    else if (pathname === '/app' || pathname === '/app/') {
      if (!authenticate(req)) {
        redirect = `/auth?returnTo=${encodeURIComponent('/app')}`;
      } else {
        pathname = '/app.html';
      }
    } else {
      try {
        pathname = decodeURIComponent(pathname);
      } catch {
        throw new HttpError(400, 'Malformed path.');
      }
      if (pathname.includes('\0')) throw new HttpError(400, 'Malformed path.');
    }

    if (redirect) {
      res.writeHead(302, { Location: redirect, 'Cache-Control': 'no-store' });
      res.end();
      return;
    }

    const relative = pathname.replace(/^\/+/, '') || 'index.html';
    const filePath = path.resolve(config.publicDir, relative);
    if (filePath !== config.publicDir && !filePath.startsWith(config.publicDir + path.sep)) {
      throw new HttpError(403, 'Forbidden.');
    }
    const ext = path.extname(filePath).toLowerCase();
    if (!STATIC_EXT.has(ext)) throw new HttpError(404, 'Not found.');

    let stat;
    try {
      stat = await fs.promises.stat(filePath);
    } catch {
      throw new HttpError(404, 'Not found.');
    }
    if (!stat.isFile()) throw new HttpError(404, 'Not found.');

    const etag = `W/"${stat.size}-${Math.floor(stat.mtimeMs)}"`;
    const cacheControl = ext === '.html' ? 'no-cache' : 'public, max-age=300';
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': cacheControl });
      res.end();
      return;
    }

    const data = await fs.promises.readFile(filePath);
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(200, {
      'Content-Type': MIME[/** @type {keyof typeof MIME} */ (ext)] || 'application/octet-stream',
      'Content-Length': String(data.length),
      'Cache-Control': cacheControl,
      ETag: etag,
    });
    if (method === 'HEAD') res.end();
    else res.end(data);
  }

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const reqId = Math.random().toString(36).slice(2, 10);
    applySecurityHeaders(req, res, config.trustProxy);
    res.setHeader('X-Request-Id', reqId);

    /** @type {string} */
    let pathname = req.url || '/';
    let status = 500;

    res.on('finish', () => {
      status = res.statusCode;
      const meta = { reqId, method: req.method, path: pathname.split('?')[0], status, ms: Date.now() - started };
      if (status >= 500) logger.error('request', meta);
      else if (status >= 400) logger.warn('request', meta);
      else logger.debug('request', meta);
    });

    try {
      if (!req.url || !req.headers.host) throw new HttpError(400, 'Malformed request.');
      const url = new URL(req.url, `http://${req.headers.host}`);
      pathname = url.pathname;
      const method = (req.method || 'GET').toUpperCase();
      const ip = clientIp(req, config.trustProxy);

      const global = rateGlobal(ip);
      if (!global.allowed) {
        return sendJson(res, 429, { error: 'Too many requests. Slow down and try again shortly.' }, rateHeaders(global));
      }
      if (['TRACE', 'CONNECT', 'OPTIONS'].includes(method)) {
        return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET, HEAD, POST, PATCH, DELETE' });
      }

      if (pathname.startsWith('/api/')) {
        if (method !== 'GET' && !isSameOrigin(req)) {
          throw new HttpError(403, 'Cross-origin request rejected.');
        }
        await handleApi(req, res, url, method, ip);
        return;
      }

      await handleStatic(req, res, url, method);
    } catch (err) {
      if (res.destroyed || res.writableEnded) return;
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message }, err.headers);
        return;
      }
      const status = err && typeof /** @type {any} */ (err).status === 'number' ? /** @type {any} */ (err).status : 0;
      if (status >= 400 && status < 500) {
        sendJson(res, status, { error: err instanceof Error ? err.message : 'Bad request.' });
        return;
      }
      logger.error('request.unhandled', { reqId, error: err instanceof Error ? err.stack : String(err) });
      sendJson(res, 500, { error: 'Internal server error.' });
    }
  });

  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

/** Start the server with production wiring (config, store, signals). */
export function main() {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const store = createStore(config.dataDir, logger);
  const server = createServer({ config, store, logger });

  server.listen(config.port, config.host, () => {
    logger.info('server.listening', { url: `http://${config.host}:${config.port}`, env: config.env, dataDir: config.dataDir });
  });

  const pruner = setInterval(() => {
    try {
      const removed = store.pruneSessions();
      if (removed > 0) logger.debug('sessions.pruned', { removed });
    } catch (err) {
      logger.warn('sessions.prune_failed', { error: String(err) });
    }
  }, 60 * 60_000);
  pruner.unref();

  let closing = false;
  /** @param {string} signal */
  const shutdown = (signal) => {
    if (closing) return;
    closing = true;
    logger.info('server.shutdown', { signal });
    clearInterval(pruner);
    server.close(() => process.exit(0));
    server.closeIdleConnections?.();
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error('process.unhandled_rejection', { error: reason instanceof Error ? reason.stack : String(reason) });
  });
  process.on('uncaughtException', (err) => {
    logger.error('process.uncaught_exception', { error: err.stack || String(err) });
    process.exit(1);
  });
  return server;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
