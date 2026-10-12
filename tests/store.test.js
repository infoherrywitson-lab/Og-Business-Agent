import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hashPassword, verifyPassword, createSessionToken, hashToken, isValidEmail, passwordProblem, roleAtLeast } from '../src/auth.js';
import { createLoginGuard } from '../src/security.js';
import { buildPlan } from '../src/planner.js';
import { createStore } from '../src/store.js';

/** @returns {string} */
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bos-store-'));
}

test('password hashing round-trips and rejects wrong passwords', async () => {
  const hash = await hashPassword('correct horse battery staple');
  assert.ok(hash.startsWith('scrypt$'));
  assert.equal(await verifyPassword('correct horse battery staple', hash), true);
  assert.equal(await verifyPassword('wrong password entirely', hash), false);
  assert.equal(await verifyPassword('correct horse battery staple', 'garbage'), false);
  assert.equal(await verifyPassword('correct horse battery staple', 'scrypt$1$1$1$AAAA$AAAA'), false);
});

test('session tokens are opaque and only stored hashed', () => {
  const a = createSessionToken();
  const b = createSessionToken();
  assert.notEqual(a.token, b.token);
  assert.equal(a.tokenHash, hashToken(a.token));
  assert.match(a.tokenHash, /^[0-9a-f]{64}$/);
  assert.notEqual(a.tokenHash, a.token);
});

test('email and password policy', () => {
  assert.equal(isValidEmail('user@example.com'), true);
  assert.equal(isValidEmail('not-an-email'), false);
  assert.equal(isValidEmail('a@b'), false);
  assert.equal(passwordProblem('short'), 'Password must be at least 10 characters long.');
  assert.ok(passwordProblem('password123'));
  assert.equal(passwordProblem('a perfectly fine passphrase'), null);
});

test('role ordering is viewer < member < admin', () => {
  assert.equal(roleAtLeast('admin', 'member'), true);
  assert.equal(roleAtLeast('member', 'admin'), false);
  assert.equal(roleAtLeast('viewer', 'member'), false);
  assert.equal(roleAtLeast('member', 'member'), true);
  assert.equal(roleAtLeast(null, 'viewer'), false);
});

test('login guard locks after repeated failures and clears on success', () => {
  const guard = createLoginGuard({ maxFails: 3, windowMs: 60_000, lockoutMs: 60_000 });
  const key = '1.2.3.4|user@example.com';
  assert.equal(guard.lockedFor(key), 0);
  guard.fail(key);
  guard.fail(key);
  assert.equal(guard.lockedFor(key), 0);
  guard.fail(key);
  assert.ok(guard.lockedFor(key) > 0);
  guard.succeed(key);
  assert.equal(guard.lockedFor(key), 0);
});

test('store persists projects, tasks, approvals and audit atomically', () => {
  const dir = tmpDir();
  const store = createStore(dir);
  const actor = { id: 'user_1', label: 'admin@example.com', role: /** @type {const} */ ('admin') };
  const plan = buildPlan('Build a website with SEO and social campaign', 'Persisted project');

  const project = store.createProject(plan, 'Build a website with SEO and social campaign', actor);
  assert.equal(project.tasks.length, plan.tasks.length);
  assert.ok(project.tasks.every((t) => t.projectId === project.id));
  assert.equal(project.status, 'planning');

  const approvals = store.listApprovals();
  assert.equal(approvals.length, project.tasks.filter((t) => t.requiresApproval).length);
  assert.ok(approvals.every((a) => a.status === 'pending' && a.requestedByLabel === actor.label));

  // task lifecycle drives project status
  const first = project.tasks[0];
  store.updateTask(project.id, first.id, { status: 'in_progress' });
  const midway = store.getProject(project.id);
  assert.ok(midway);
  assert.equal(midway.status, 'active');
  for (const t of midway.tasks) {
    store.updateTask(project.id, t.id, { status: 'completed' });
  }
  const finished = store.getProject(project.id);
  assert.ok(finished);
  assert.equal(finished.status, 'completed');
  assert.equal(store.getStats().completedTasks, project.tasks.length);

  // approval decisions are one-shot and audited
  const approval = store.listApprovals()[0];
  const decided = store.decideApproval(approval.id, 'approved', 'go ahead', actor);
  assert.ok(decided);
  assert.equal(decided.status, 'approved');
  assert.equal(decided.decidedByLabel, actor.label);
  let conflict = false;
  try {
    store.decideApproval(approval.id, 'rejected', 'again', actor);
  } catch (err) {
    conflict = typeof err === 'object' && err !== null && /** @type {any} */ (err).status === 409;
  }
  assert.equal(conflict, true, 'second decision must conflict');

  const audit = store.listAudit(50);
  assert.ok(audit.some((e) => e.action === 'project.created' && e.actorLabel === actor.label));
  assert.ok(audit.some((e) => e.action === 'approval.approved'));
  store.logAudit('task.updated', first.id, { status: 'completed' }, actor);
  assert.ok(store.listAudit(50).some((e) => e.action === 'task.updated' && e.actorLabel === actor.label));

  // data survives a fresh process reading the same directory
  const reopened = createStore(dir);
  assert.equal(reopened.listProjects().length, 1);
  assert.equal(reopened.listApprovals()[0].status, 'approved');
});

test('store backs up a corrupt database instead of silently wiping it', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'db.json'), '{ this is not json');
  const store = createStore(dir);
  assert.deepEqual(store.listProjects(), []);
  const backups = fs.readdirSync(dir).filter((f) => f.includes('.corrupt-'));
  assert.equal(backups.length, 1);
  // new file is valid JSON again
  const fresh = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'));
  assert.equal(fresh.version, 2);
});

test('store migrates legacy MVP records without losing them', () => {
  const dir = tmpDir();
  const legacy = {
    projects: [{
      id: 'proj_old',
      name: 'Legacy project',
      prompt: 'old prompt',
      plan: { projectName: 'Legacy project', summary: 's', deliverables: [], acceptanceCriteria: [], tasks: [], safety: {} },
      status: 'planning',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      tasks: [{ id: 't1', agent: 'A', role: 'planner', title: 'T', description: '', status: 'queued', priority: 'normal', requiresApproval: false }],
    }],
    approvals: [{ id: 'ap1', projectId: 'proj_old', taskId: 't1', title: 'Old approval', description: 'd', status: 'pending', createdAt: '2024-01-01T00:00:00.000Z', decidedAt: null }],
    auditLogs: [{ id: 'au1', action: 'project.created', entityId: 'proj_old', detail: {}, createdAt: '2024-01-01T00:00:00.000Z' }],
  };
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify(legacy));
  const store = createStore(dir);
  assert.equal(store.listProjects().length, 1);
  assert.equal(store.listProjects()[0].tasks[0].projectId, 'proj_old');
  assert.equal(store.listApprovals().length, 1);
  assert.equal(store.listAudit(10)[0].action, 'project.created');
  assert.equal(store.countUsers(), 0);
});

test('users, sessions and role updates behave safely', () => {
  const dir = tmpDir();
  const store = createStore(dir);
  const admin = store.createUser({ email: 'Admin@Example.com', name: 'Admin', role: 'admin', passwordHash: 'hash-a' });
  assert.equal(admin.email, 'admin@example.com');
  assert.ok(store.getUserByEmail('ADMIN@example.com'));
  assert.equal(store.getUserByEmail('nobody@example.com'), null);

  const { tokenHash } = createSessionToken();
  store.createSession({ tokenHash, userId: admin.id, ip: '127.0.0.1', ttlMs: 60_000 });
  const found = store.findSession(tokenHash);
  assert.ok(found);
  assert.equal(found.userId, admin.id);
  store.touchSession(tokenHash, 120_000);
  assert.ok(store.findSession(tokenHash));
  store.deleteSession(tokenHash);
  assert.equal(store.findSession(tokenHash), null);

  // expired sessions are pruned
  store.createSession({ tokenHash: 'expired', userId: admin.id, ip: '', ttlMs: -1000 });
  assert.equal(store.pruneSessions(), 1);

  // password reset revokes the user's sessions
  store.createSession({ tokenHash: 'active', userId: admin.id, ip: '', ttlMs: 60_000 });
  store.updateUser(admin.id, { passwordHash: 'hash-b' });
  assert.equal(store.findSession('active'), null);
  const reloaded = store.getUserById(admin.id);
  assert.ok(reloaded);
  assert.equal(reloaded.passwordHash, 'hash-b');
  assert.equal(store.getStats().users, 1);
});
