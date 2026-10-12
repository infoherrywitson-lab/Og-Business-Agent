import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { loadConfig } from '../src/config.js';
import { nullLogger } from '../src/logger.js';
import { createStore } from '../src/store.js';
import { createServer } from '../src/server.js';

/**
 * Boot an isolated server on an ephemeral port with its own temp database.
 * @param {Record<string, any>} [overrides]
 */
async function startApp(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bos-api-'));
  const config = Object.assign(loadConfig({}), { dataDir: dir, env: /** @type {const} */ ('development'), trustProxy: false }, overrides);
  const store = createStore(dir, nullLogger);
  const server = createServer({ config, store, logger: nullLogger });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(null)));
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : 0;
  return {
    server,
    store,
    config,
    dir,
    port,
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve(null))),
  };
}

/**
 * @param {string} base
 * @param {string} urlPath
 * @param {{method?: string, body?: unknown, cookie?: string, headers?: Record<string, string>, raw?: string}} [opts]
 */
function api(base, urlPath, opts = {}) {
  /** @type {Record<string, string>} */
  const headers = { 'X-Requested-With': 'fetch', ...(opts.headers || {}) };
  if (opts.cookie) headers.Cookie = opts.cookie;
  const hasBody = opts.body !== undefined || opts.raw !== undefined;
  if (hasBody) headers['Content-Type'] = 'application/json';
  const body = opts.raw !== undefined ? opts.raw : opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
  return fetch(base + urlPath, {
    method: opts.method || 'GET',
    headers,
    body,
    redirect: 'manual',
  }).then(async (res) => {
    const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    const sessionCookie = cookies.find((c) => c.startsWith('bos_session=')) || '';
    const text = await res.text();
    /** @type {any} */
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, data, cookies, sessionCookie, headers: res.headers };
  });
}

/**
 * Raw HTTP request (bypasses client URL normalisation — used for traversal
 * and oversized-body probes).
 * @param {number} port
 * @param {string} urlPath
 * @param {{method?: string, body?: string, headers?: Record<string, string>}} [opts]
 */
function raw(port, urlPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const body = opts.body || '';
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: urlPath,
      method: opts.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
        ...(opts.headers || {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += String(chunk); });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const ADMIN = { email: 'admin@example.com', name: 'Ada Admin', password: 'correct horse battery' };

/** @param {Awaited<ReturnType<typeof startApp>>} app */
async function setupAdmin(app) {
  const res = await api(app.base, '/api/auth/setup', { method: 'POST', body: ADMIN });
  assert.equal(res.status, 201);
  return res.sessionCookie;
}

// --- health & baseline protection -----------------------------------------

test('health is public and never exposes secrets', async () => {
  const app = await startApp();
  try {
    const res = await api(app.base, '/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
    assert.equal(res.data.externalActionsEnabled, false);
    assert.equal(res.data.aiConfigured, false);
    assert.ok(!JSON.stringify(res.data).includes('apiKey'));
    const csp = res.headers.get('content-security-policy');
    assert.ok(csp && !csp.includes('unsafe-inline'), 'CSP must not allow inline scripts');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
  } finally {
    await app.close();
  }
});

test('API requires authentication before anything else', async () => {
  const app = await startApp();
  try {
    for (const p of ['/api/stats', '/api/projects', '/api/approvals', '/api/audit', '/api/me', '/api/users']) {
      const res = await api(app.base, p);
      assert.equal(res.status, 401, `${p} must be protected`);
    }
    const state = await api(app.base, '/api/auth/state');
    assert.equal(state.status, 200);
    assert.equal(state.data.setupRequired, true);
  } finally {
    await app.close();
  }
});

// --- auth lifecycle --------------------------------------------------------

test('first-run setup creates one admin, then sign-in works', async () => {
  const app = await startApp();
  try {
    const weak = await api(app.base, '/api/auth/setup', { method: 'POST', body: { email: 'a@b.co', name: 'A', password: 'short' } });
    assert.equal(weak.status, 400);

    const first = await api(app.base, '/api/auth/setup', { method: 'POST', body: ADMIN });
    assert.equal(first.status, 201);
    assert.equal(first.data.user.role, 'admin');
    assert.ok(first.sessionCookie.includes('HttpOnly'));

    const again = await api(app.base, '/api/auth/setup', { method: 'POST', body: { email: 'x@y.co', name: 'X', password: 'another long password' } });
    assert.equal(again.status, 403, 'setup must lock after the first admin');

    const badLogin = await api(app.base, '/api/auth/login', { method: 'POST', body: { email: ADMIN.email, password: 'wrong-password-xx' } });
    assert.equal(badLogin.status, 401);

    const login = await api(app.base, '/api/auth/login', { method: 'POST', body: { email: ADMIN.email.toUpperCase(), password: ADMIN.password } });
    assert.equal(login.status, 200);
    const cookie = login.sessionCookie;
    assert.ok(cookie, 'login must set a session cookie');

    const me = await api(app.base, '/api/me', { cookie });
    assert.equal(me.status, 200);
    assert.equal(me.data.user.email, ADMIN.email);
    assert.equal(me.data.user.passwordHash, undefined, 'hashes must never leave the server');

    const state = await api(app.base, '/api/auth/state');
    assert.equal(state.data.setupRequired, false);

    const logout = await api(app.base, '/api/auth/logout', { method: 'POST', cookie });
    assert.equal(logout.status, 200);
    const after = await api(app.base, '/api/me', { cookie });
    assert.equal(after.status, 401, 'session must be dead after logout');
  } finally {
    await app.close();
  }
});

// --- project intake & tracking --------------------------------------------

test('brief becomes a plan, tasks drive stats, audit records actors', async () => {
  const app = await startApp();
  try {
    const cookie = await setupAdmin(app);

    const short = await api(app.base, '/api/projects', { method: 'POST', cookie, body: { prompt: 'tiny' } });
    assert.equal(short.status, 400);

    const created = await api(app.base, '/api/projects', {
      method: 'POST',
      cookie,
      body: { name: 'Fusion Kids', prompt: 'Build a mobile-friendly website, SEO plan and 30-day social calendar' },
    });
    assert.equal(created.status, 201);
    const project = created.data.project;
    assert.equal(project.name, 'Fusion Kids');
    assert.ok(project.tasks.length >= 7);
    assert.equal(project.plan.planningMode, 'rules-based fallback');
    assert.ok(project.plan.deliverables.length >= 1);

    const stats1 = await api(app.base, '/api/stats', { cookie });
    assert.equal(stats1.data.projects, 1);

    const task = project.tasks[0];
    const patched = await api(app.base, `/api/projects/${project.id}/tasks/${task.id}`, {
      method: 'PATCH',
      cookie,
      body: { status: 'in_progress' },
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.data.task.status, 'in_progress');

    const badStatus = await api(app.base, `/api/projects/${project.id}/tasks/${task.id}`, {
      method: 'PATCH',
      cookie,
      body: { status: 'nonsense' },
    });
    assert.equal(badStatus.status, 400);

    for (const t of project.tasks) {
      await api(app.base, `/api/projects/${project.id}/tasks/${t.id}`, { method: 'PATCH', cookie, body: { status: 'completed' } });
    }
    const stats2 = await api(app.base, '/api/stats', { cookie });
    assert.equal(stats2.data.completedTasks, project.tasks.length);
    const reread = await api(app.base, `/api/projects/${project.id}`, { cookie });
    assert.equal(reread.data.project.status, 'completed');

    const audit = await api(app.base, '/api/audit', { cookie });
    assert.ok(audit.data.events.some((/** @type {any} */ e) => e.action === 'project.created' && e.actorLabel === ADMIN.email));
    assert.ok(audit.data.events.some((/** @type {any} */ e) => e.action === 'task.updated'));
    assert.ok(audit.data.events.some((/** @type {any} */ e) => e.action === 'auth.setup'));

    const deleted = await api(app.base, `/api/projects/${project.id}`, { method: 'DELETE', cookie });
    assert.equal(deleted.status, 200);
    const stats3 = await api(app.base, '/api/stats', { cookie });
    assert.equal(stats3.data.projects, 0);
    const gone = await api(app.base, `/api/projects/${project.id}`, { cookie });
    assert.equal(gone.status, 404);
  } finally {
    await app.close();
  }
});

// --- RBAC ------------------------------------------------------------------

test('roles are enforced: viewer read-only, member plans, admin decides', async () => {
  const app = await startApp();
  try {
    const adminCookie = await setupAdmin(app);

    const member = await api(app.base, '/api/users', {
      method: 'POST',
      cookie: adminCookie,
      body: { email: 'mem@example.com', name: 'Mo Member', password: 'member password', role: 'member' },
    });
    assert.equal(member.status, 201);
    const viewer = await api(app.base, '/api/users', {
      method: 'POST',
      cookie: adminCookie,
      body: { email: 'view@example.com', name: 'Vi Viewer', password: 'viewer password', role: 'viewer' },
    });
    assert.equal(viewer.status, 201);

    const dup = await api(app.base, '/api/users', {
      method: 'POST',
      cookie: adminCookie,
      body: { email: 'mem@example.com', name: 'Dup', password: 'duplicate password', role: 'member' },
    });
    assert.equal(dup.status, 409);

    const memberLogin = await api(app.base, '/api/auth/login', { method: 'POST', body: { email: 'mem@example.com', password: 'member password' } });
    const memberCookie = memberLogin.sessionCookie;
    const viewerLogin = await api(app.base, '/api/auth/login', { method: 'POST', body: { email: 'view@example.com', password: 'viewer password' } });
    const viewerCookie = viewerLogin.sessionCookie;

    // viewer can read but not write
    const viewerRead = await api(app.base, '/api/projects', { cookie: viewerCookie });
    assert.equal(viewerRead.status, 200);
    const viewerWrite = await api(app.base, '/api/projects', { method: 'POST', cookie: viewerCookie, body: { prompt: 'let me create a project please' } });
    assert.equal(viewerWrite.status, 403);

    // member can plan and update tasks
    const memberPlan = await api(app.base, '/api/projects', { method: 'POST', cookie: memberCookie, body: { prompt: 'Plan a website and SEO campaign for my shop' } });
    assert.equal(memberPlan.status, 201);
    const taskId = memberPlan.data.project.tasks[0].id;
    const memberTask = await api(app.base, `/api/projects/${memberPlan.data.project.id}/tasks/${taskId}`, { method: 'PATCH', cookie: memberCookie, body: { status: 'in_progress' } });
    assert.equal(memberTask.status, 200);

    // member cannot see the team or delete projects
    assert.equal((await api(app.base, '/api/users', { cookie: memberCookie })).status, 403);
    assert.equal((await api(app.base, `/api/projects/${memberPlan.data.project.id}`, { method: 'DELETE', cookie: memberCookie })).status, 403);

    // member cannot decide approvals; admin can
    const approvals = await api(app.base, '/api/approvals', { cookie: adminCookie });
    assert.ok(approvals.data.approvals.length >= 1);
    const approvalId = approvals.data.approvals.find((/** @type {any} */ a) => a.status === 'pending').id;
    const memberDecide = await api(app.base, `/api/approvals/${approvalId}`, { method: 'POST', cookie: memberCookie, body: { decision: 'approved' } });
    assert.equal(memberDecide.status, 403);

    const badDecision = await api(app.base, `/api/approvals/${approvalId}`, { method: 'POST', cookie: adminCookie, body: { decision: 'maybe' } });
    assert.equal(badDecision.status, 400);

    const decide = await api(app.base, `/api/approvals/${approvalId}`, { method: 'POST', cookie: adminCookie, body: { decision: 'approved', note: 'looks good' } });
    assert.equal(decide.status, 200);
    assert.equal(decide.data.approval.decidedByLabel, ADMIN.email);

    const again = await api(app.base, `/api/approvals/${approvalId}`, { method: 'POST', cookie: adminCookie, body: { decision: 'rejected' } });
    assert.equal(again.status, 409, 'approvals are one-shot');

    // the workspace must keep an active admin
    const adminId = (await api(app.base, '/api/me', { cookie: adminCookie })).data.user.id;
    const selfDemote = await api(app.base, `/api/users/${adminId}`, { method: 'PATCH', cookie: adminCookie, body: { role: 'member' } });
    assert.equal(selfDemote.status, 409);
  } finally {
    await app.close();
  }
});

// --- request hardening -----------------------------------------------------

test('cross-site requests, bad bodies and unknown routes are rejected', async () => {
  const app = await startApp();
  try {
    const cookie = await setupAdmin(app);

    const evilOrigin = await api(app.base, '/api/projects', {
      method: 'POST',
      cookie,
      headers: { Origin: 'https://evil.example' },
      body: { prompt: 'csrf attempt with a long enough prompt' },
    });
    assert.equal(evilOrigin.status, 403);

    const crossSite = await api(app.base, '/api/projects', {
      method: 'POST',
      cookie,
      headers: { 'Sec-Fetch-Site': 'cross-site' },
      body: { prompt: 'csrf attempt with a long enough prompt' },
    });
    assert.equal(crossSite.status, 403);

    const goodOrigin = await api(app.base, '/api/projects', {
      method: 'POST',
      cookie,
      headers: { Origin: app.base },
      body: { prompt: 'legit same-origin request with a long enough prompt' },
    });
    assert.equal(goodOrigin.status, 201);

    const badJson = await api(app.base, '/api/projects', { method: 'POST', cookie, raw: '{not json' });
    assert.equal(badJson.status, 400);

    const arrayBody = await api(app.base, '/api/projects', { method: 'POST', cookie, raw: '[1,2,3]' });
    assert.equal(arrayBody.status, 400);

    const unknown = await api(app.base, '/api/nope', { cookie });
    assert.equal(unknown.status, 404);

    const options = await api(app.base, '/api/stats', { method: 'OPTIONS', cookie });
    assert.equal(options.status, 405);
  } finally {
    await app.close();
  }
});

test('static delivery: pages, headers, redirects and traversal defence', async () => {
  const app = await startApp();
  try {
    const landing = await api(app.base, '/');
    assert.equal(landing.status, 200);
    assert.ok(String(landing.data).includes('Business OS'));

    const authPage = await api(app.base, '/auth');
    assert.equal(authPage.status, 200);

    const css = await api(app.base, '/styles.css');
    assert.equal(css.status, 200);
    assert.ok(String(css.headers.get('content-type')).includes('text/css'));

    const appPage = await api(app.base, '/app');
    assert.equal(appPage.status, 302);
    assert.ok(String(appPage.headers.get('location')).startsWith('/auth?returnTo='));

    const traversal = await raw(app.port, '/..%2f..%2fpackage.json');
    assert.ok(traversal.status === 403 || traversal.status === 404, `traversal blocked, got ${traversal.status}`);
    assert.ok(!traversal.body.includes('"scripts"'));

    const traversal2 = await raw(app.port, '/%2e%2e/%2e%2e/src/server.js');
    assert.ok(traversal2.status === 403 || traversal2.status === 404);
    assert.ok(!traversal2.body.includes('createServer'));

    const missing = await api(app.base, '/does-not-exist.html');
    assert.equal(missing.status, 404);

    const postStatic = await api(app.base, '/', { method: 'POST', raw: '{}' });
    assert.equal(postStatic.status, 405);

    const head = await fetch(app.base + '/styles.css', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal((await head.text()), '');
  } finally {
    await app.close();
  }
});

test('oversized request bodies are refused with 413', async () => {
  const app = await startApp({ bodyLimitBytes: 2048 });
  try {
    const big = JSON.stringify({ email: 'a@b.co', password: 'x'.repeat(8000) });
    const res = await raw(app.port, '/api/auth/login', { method: 'POST', body: big, headers: { 'Content-Length': String(big.length) } });
    assert.equal(res.status, 413);
  } finally {
    await app.close();
  }
});

test('rate limiting returns 429 with Retry-After', async () => {
  const rate = { windowMs: 60_000, max: 3, authWindowMs: 60_000, authMax: 2, planWindowMs: 60_000, planMax: 10 };
  const app = await startApp({ rate });
  try {
    const attempts = [];
    for (let i = 0; i < 5; i += 1) {
      attempts.push(await api(app.base, '/api/health'));
    }
    const blocked = attempts.find((r) => r.status === 429);
    assert.ok(blocked, 'requests beyond the limit must be throttled');
    assert.ok(blocked.headers.get('retry-after'));
    assert.equal(blocked.headers.get('x-ratelimit-limit'), '3');
  } finally {
    await app.close();
  }
});
