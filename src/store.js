import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { nullLogger } from './logger.js';

/**
 * Atomic, crash-safe JSON persistence for a single server process.
 *
 * Every operation reads the current file, applies the change in memory and
 * writes a temp file that is fsync'd and renamed over the real file, so a
 * crash mid-write never corrupts existing data. If an existing file is
 * unreadable it is preserved as a `.corrupt-<ts>` backup instead of being
 * silently overwritten.
 */

const SCHEMA_VERSION = 2;
const AUDIT_LIMIT = 1000;
const TASK_STATUSES = new Set(['queued', 'in_progress', 'completed', 'blocked']);
const PROJECT_STATUSES = new Set(['planning', 'active', 'completed', 'archived']);
const ROLES = new Set(['admin', 'member', 'viewer']);

/** @returns {import('./types.js').DB} */
function emptyDb() {
  return { version: SCHEMA_VERSION, users: [], sessions: [], projects: [], approvals: [], auditLogs: [] };
}

/**
 * @param {string} prefix
 */
function id(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

/**
 * Normalize untrusted/older records into the current schema.
 * @param {any} parsed
 * @returns {import('./types.js').DB}
 */
function migrate(parsed) {
  const db = emptyDb();
  if (!parsed || typeof parsed !== 'object') return db;

  if (Array.isArray(parsed.users)) {
    for (const raw of parsed.users) {
      if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || typeof raw.email !== 'string') continue;
      db.users.push({
        id: raw.id,
        email: String(raw.email).toLowerCase().slice(0, 254),
        name: typeof raw.name === 'string' ? raw.name.slice(0, 120) : raw.email,
        role: ROLES.has(raw.role) ? raw.role : 'member',
        passwordHash: typeof raw.passwordHash === 'string' ? raw.passwordHash : '',
        active: raw.active !== false,
        createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
        updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
        lastLoginAt: typeof raw.lastLoginAt === 'string' ? raw.lastLoginAt : null,
      });
    }
  }

  if (Array.isArray(parsed.sessions)) {
    for (const raw of parsed.sessions) {
      if (!raw || typeof raw !== 'object' || typeof raw.tokenHash !== 'string' || typeof raw.userId !== 'string') continue;
      db.sessions.push({
        tokenHash: raw.tokenHash,
        userId: raw.userId,
        createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
        expiresAt: typeof raw.expiresAt === 'string' ? raw.expiresAt : new Date(0).toISOString(),
        lastSeenAt: typeof raw.lastSeenAt === 'string' ? raw.lastSeenAt : new Date().toISOString(),
        ip: typeof raw.ip === 'string' ? raw.ip : '',
      });
    }
  }

  if (Array.isArray(parsed.projects)) {
    for (const raw of parsed.projects) {
      if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') continue;
      const now = typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString();
      const createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : now;
      /** @type {import('./types.js').Task[]} */
      const tasks = [];
      if (Array.isArray(raw.tasks)) {
        for (const t of raw.tasks) {
          if (!t || typeof t !== 'object' || typeof t.id !== 'string') continue;
          tasks.push({
            id: t.id,
            projectId: raw.id,
            agent: typeof t.agent === 'string' ? t.agent : 'Agent',
            role: typeof t.role === 'string' ? t.role : 'general',
            title: typeof t.title === 'string' ? t.title : 'Task',
            description: typeof t.description === 'string' ? t.description : '',
            status: TASK_STATUSES.has(t.status) ? t.status : 'queued',
            priority: t.priority === 'high' ? 'high' : 'normal',
            requiresApproval: t.requiresApproval === true,
            output: typeof t.output === 'string' ? t.output : null,
            createdAt: typeof t.createdAt === 'string' ? t.createdAt : createdAt,
            updatedAt: typeof t.updatedAt === 'string' ? t.updatedAt : now,
          });
        }
      }
      db.projects.push({
        id: raw.id,
        name: typeof raw.name === 'string' ? raw.name : 'Untitled project',
        prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
        plan: raw.plan && typeof raw.plan === 'object' ? raw.plan : { projectName: '', summary: '', languageDetected: '', deliverables: [], acceptanceCriteria: [], tasks: [], safety: {} },
        status: PROJECT_STATUSES.has(raw.status) ? raw.status : 'planning',
        createdById: typeof raw.createdById === 'string' ? raw.createdById : 'system',
        createdByLabel: typeof raw.createdByLabel === 'string' ? raw.createdByLabel : 'imported',
        createdAt,
        updatedAt: now,
        tasks,
      });
    }
  }

  if (Array.isArray(parsed.approvals)) {
    for (const raw of parsed.approvals) {
      if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') continue;
      db.approvals.push({
        id: raw.id,
        projectId: typeof raw.projectId === 'string' ? raw.projectId : '',
        taskId: typeof raw.taskId === 'string' ? raw.taskId : '',
        title: typeof raw.title === 'string' ? raw.title : 'Approval',
        description: typeof raw.description === 'string' ? raw.description : '',
        status: raw.status === 'approved' || raw.status === 'rejected' ? raw.status : 'pending',
        requestedById: typeof raw.requestedById === 'string' ? raw.requestedById : 'system',
        requestedByLabel: typeof raw.requestedByLabel === 'string' ? raw.requestedByLabel : 'imported',
        decidedById: typeof raw.decidedById === 'string' ? raw.decidedById : null,
        decidedByLabel: typeof raw.decidedByLabel === 'string' ? raw.decidedByLabel : null,
        note: typeof raw.note === 'string' ? raw.note : null,
        createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
        decidedAt: typeof raw.decidedAt === 'string' ? raw.decidedAt : null,
      });
    }
  }

  if (Array.isArray(parsed.auditLogs)) {
    for (const raw of parsed.auditLogs) {
      if (!raw || typeof raw !== 'object' || typeof raw.action !== 'string') continue;
      db.auditLogs.push({
        id: typeof raw.id === 'string' ? raw.id : id('audit'),
        action: raw.action,
        entityId: typeof raw.entityId === 'string' ? raw.entityId : '',
        actorId: typeof raw.actorId === 'string' ? raw.actorId : 'system',
        actorLabel: typeof raw.actorLabel === 'string' ? raw.actorLabel : 'system',
        detail: raw.detail && typeof raw.detail === 'object' ? raw.detail : {},
        createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
      });
    }
  }

  return db;
}

/**
 * @typedef {Object} Store
 * @property {() => import('./types.js').User[]} listUsers
 * @property {(userId: string) => import('./types.js').User|null} getUserById
 * @property {(email: string) => import('./types.js').User|null} getUserByEmail
 * @property {() => number} countUsers
 * @property {(input: {email: string, name: string, role: import('./types.js').Role, passwordHash: string}) => import('./types.js').User} createUser
 * @property {(userId: string, patch: {name?: string, role?: import('./types.js').Role, active?: boolean, passwordHash?: string}) => import('./types.js').User|null} updateUser
 * @property {(session: {tokenHash: string, userId: string, ip: string, ttlMs: number}) => import('./types.js').Session} createSession
 * @property {(tokenHash: string) => import('./types.js').Session|null} findSession
 * @property {(tokenHash: string, ttlMs: number) => void} touchSession
 * @property {(tokenHash: string) => void} deleteSession
 * @property {(userId: string) => void} deleteSessionsForUser
 * @property {() => number} pruneSessions
 * @property {() => import('./types.js').Project[]} listProjects
 * @property {(projectId: string) => import('./types.js').Project|null} getProject
 * @property {(plan: import('./types.js').Plan, prompt: string, actor: import('./types.js').Actor) => import('./types.js').Project} createProject
 * @property {(projectId: string, taskId: string, patch: {status?: import('./types.js').TaskStatus, output?: string|null}) => import('./types.js').Task|null} updateTask
 * @property {(projectId: string, actor: {id: string, label: string}) => boolean} deleteProject
 * @property {() => import('./types.js').Approval[]} listApprovals
 * @property {(approvalId: string, decision: 'approved'|'rejected', note: string, actor: import('./types.js').Actor) => import('./types.js').Approval|null} decideApproval
 * @property {(limit?: number) => import('./types.js').AuditEvent[]} listAudit
 * @property {(action: string, entityId: string, detail: Record<string, unknown>, actor: {id: string, label: string}) => void} logAudit
 * @property {(userId: string) => void} markLogin
 * @property {() => {projects: number, tasks: number, pendingApprovals: number, completedTasks: number, auditEvents: number, users: number}} getStats
 * @property {() => import('./types.js').DB} snapshot
 */

/**
 * @param {string} dir
 * @param {import('./types.js').Logger} [logger]
 * @returns {Store}
 */
export function createStore(dir, logger = nullLogger) {
  const dbPath = path.join(dir, 'db.json');

  function ensureDir() {
    fs.mkdirSync(dir, { recursive: true });
  }

  /** @returns {import('./types.js').DB} */
  function load() {
    ensureDir();
    if (!fs.existsSync(dbPath)) {
      const fresh = emptyDb();
      persist(fresh);
      return fresh;
    }
    let raw;
    try {
      raw = fs.readFileSync(dbPath, 'utf8');
    } catch (err) {
      logger.error('store.read_failed', { error: String(err) });
      return emptyDb();
    }
    try {
      return migrate(JSON.parse(raw));
    } catch {
      const backup = `${dbPath}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(dbPath, backup);
        logger.error('store.corrupt_backed_up', { backup });
      } catch (renameErr) {
        logger.error('store.corrupt_backup_failed', { error: String(renameErr) });
      }
      const fresh = emptyDb();
      persist(fresh);
      return fresh;
    }
  }

  /** @param {import('./types.js').DB} db */
  function persist(db) {
    ensureDir();
    const tmp = `${dbPath}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, JSON.stringify(db, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, dbPath);
    try {
      const dfd = fs.openSync(dir, 'r');
      try {
        fs.fsyncSync(dfd);
      } finally {
        fs.closeSync(dfd);
      }
    } catch {
      // Directory fsync is not supported everywhere; the file rename above
      // still guarantees we never observe a half-written database.
    }
  }

  /**
   * Read-modify-write transaction. The process is single-threaded, so no
   * other request can interleave between load() and persist().
   * @template T
   * @param {(db: import('./types.js').DB) => T} fn
   * @returns {T}
   */
  function update(fn) {
    const db = load();
    const result = fn(db);
    persist(db);
    return result;
  }

  /**
   * @template T
   * @param {(db: import('./types.js').DB) => T} fn
   * @returns {T}
   */
  function view(fn) {
    return fn(load());
  }

  /**
   * @param {import('./types.js').DB} db
   * @param {string} action
   * @param {string} entityId
   * @param {Record<string, unknown>} detail
   * @param {import('./types.js').Actor| {id: string, label: string}} actor
   */
  function audit(db, action, entityId, detail, actor) {
    db.auditLogs.unshift({
      id: id('audit'),
      action,
      entityId,
      actorId: actor.id,
      actorLabel: actor.label,
      detail,
      createdAt: new Date().toISOString(),
    });
    if (db.auditLogs.length > AUDIT_LIMIT) db.auditLogs.length = AUDIT_LIMIT;
  }

  /** @type {Store} */
  const store = {
    // --- users -------------------------------------------------------------
    listUsers: () => view((db) => db.users.slice().sort((a, b) => a.email.localeCompare(b.email))),
    getUserById: (userId) => view((db) => db.users.find((u) => u.id === userId) || null),
    getUserByEmail: (email) => view((db) => db.users.find((u) => u.email === email.toLowerCase()) || null),
    countUsers: () => view((db) => db.users.length),
    createUser: (input) =>
      update((db) => {
        const now = new Date().toISOString();
        /** @type {import('./types.js').User} */
        const user = {
          id: id('user'),
          email: input.email.toLowerCase(),
          name: input.name,
          role: input.role,
          passwordHash: input.passwordHash,
          active: true,
          createdAt: now,
          updatedAt: now,
          lastLoginAt: null,
        };
        db.users.push(user);
        audit(db, 'user.created', user.id, { email: user.email, role: user.role }, { id: user.id, label: user.email });
        return user;
      }),
    updateUser: (userId, patch) =>
      update((db) => {
        const user = db.users.find((u) => u.id === userId);
        if (!user) return null;
        if (patch.name !== undefined) user.name = patch.name;
        if (patch.role !== undefined) user.role = patch.role;
        if (patch.active !== undefined) user.active = patch.active;
        if (patch.passwordHash !== undefined) user.passwordHash = patch.passwordHash;
        user.updatedAt = new Date().toISOString();
        if (patch.passwordHash !== undefined) {
          db.sessions = db.sessions.filter((s) => s.userId !== user.id);
        }
        audit(db, 'user.updated', user.id, {
          email: user.email,
          role: user.role,
          active: user.active,
          passwordReset: patch.passwordHash !== undefined,
        }, { id: user.id, label: user.email });
        return user;
      }),

    // --- sessions ----------------------------------------------------------
    createSession: (input) =>
      update((db) => {
        const now = Date.now();
        /** @type {import('./types.js').Session} */
        const session = {
          tokenHash: input.tokenHash,
          userId: input.userId,
          createdAt: new Date(now).toISOString(),
          expiresAt: new Date(now + input.ttlMs).toISOString(),
          lastSeenAt: new Date(now).toISOString(),
          ip: input.ip,
        };
        db.sessions = db.sessions.filter((s) => s.expiresAt > new Date(now - 1).toISOString() && s.tokenHash !== input.tokenHash);
        db.sessions.push(session);
        return session;
      }),
    findSession: (tokenHash) => view((db) => db.sessions.find((s) => s.tokenHash === tokenHash) || null),
    touchSession: (tokenHash, ttlMs) =>
      update((db) => {
        const session = db.sessions.find((s) => s.tokenHash === tokenHash);
        if (!session) return;
        const now = Date.now();
        session.lastSeenAt = new Date(now).toISOString();
        session.expiresAt = new Date(now + ttlMs).toISOString();
      }),
    deleteSession: (tokenHash) =>
      update((db) => {
        db.sessions = db.sessions.filter((s) => s.tokenHash !== tokenHash);
      }),
    deleteSessionsForUser: (userId) =>
      update((db) => {
        db.sessions = db.sessions.filter((s) => s.userId !== userId);
      }),
    pruneSessions: () =>
      update((db) => {
        const before = db.sessions.length;
        const now = new Date().toISOString();
        db.sessions = db.sessions.filter((s) => s.expiresAt > now);
        return before - db.sessions.length;
      }),

    // --- projects ----------------------------------------------------------
    listProjects: () =>
      view((db) => db.projects.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt))),
    getProject: (projectId) => view((db) => db.projects.find((p) => p.id === projectId) || null),
    createProject: (plan, prompt, actor) =>
      update((db) => {
        const now = new Date().toISOString();
        /** @type {import('./types.js').Project} */
        const project = {
          id: id('proj'),
          name: String(plan.projectName || 'New project').slice(0, 120),
          prompt,
          plan,
          status: 'planning',
          createdById: actor.id,
          createdByLabel: actor.label,
          createdAt: now,
          updatedAt: now,
          tasks: [],
        };
        project.tasks = (plan.tasks || []).map((t) => ({
          id: `${project.id}_${t.id}`,
          projectId: project.id,
          agent: t.agent,
          role: t.role,
          title: t.title,
          description: t.description,
          status: t.status === 'in_progress' || t.status === 'completed' || t.status === 'blocked' ? t.status : 'queued',
          priority: t.priority === 'high' ? 'high' : 'normal',
          requiresApproval: t.requiresApproval === true,
          output: t.output ?? null,
          createdAt: now,
          updatedAt: now,
        }));
        db.projects.push(project);
        for (const t of project.tasks.filter((task) => task.requiresApproval)) {
          db.approvals.push({
            id: id('approval'),
            projectId: project.id,
            taskId: t.id,
            title: `Approve execution: ${t.title}`,
            description: 'Recording a decision does not execute anything. External publishing, ad spend, purchases, deployments and outreach stay disabled until integrated and separately approved.',
            status: 'pending',
            requestedById: actor.id,
            requestedByLabel: actor.label,
            decidedById: null,
            decidedByLabel: null,
            note: null,
            createdAt: now,
            decidedAt: null,
          });
        }
        audit(db, 'project.created', project.id, { name: project.name, taskCount: project.tasks.length }, actor);
        return project;
      }),
    updateTask: (projectId, taskId, patch) =>
      update((db) => {
        const project = db.projects.find((p) => p.id === projectId);
        if (!project) return null;
        const task = project.tasks.find((t) => t.id === taskId);
        if (!task) return null;
        const before = task.status;
        if (patch.status && TASK_STATUSES.has(patch.status)) task.status = patch.status;
        if (patch.output !== undefined) task.output = patch.output === null ? null : String(patch.output).slice(0, 4000);
        task.updatedAt = new Date().toISOString();
        project.updatedAt = task.updatedAt;
        const allDone = project.tasks.length > 0 && project.tasks.every((t) => t.status === 'completed');
        const anyStarted = project.tasks.some((t) => t.status !== 'queued');
        project.status = allDone ? 'completed' : anyStarted ? 'active' : 'planning';
        return task;
      }),
    deleteProject: (projectId, actor) =>
      update((db) => {
        const index = db.projects.findIndex((p) => p.id === projectId);
        if (index < 0) return false;
        const [removed] = db.projects.splice(index, 1);
        db.approvals = db.approvals.filter((a) => a.projectId !== projectId);
        audit(db, 'project.deleted', projectId, { name: removed.name }, actor);
        return true;
      }),

    // --- approvals ---------------------------------------------------------
    listApprovals: () =>
      view((db) => db.approvals.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt))),
    decideApproval: (approvalId, decision, note, actor) =>
      update((db) => {
        const item = db.approvals.find((a) => a.id === approvalId);
        if (!item) return null;
        if (item.status !== 'pending') {
          const err = new Error('Approval has already been decided');
          /** @type {any} */ (err).status = 409;
          throw err;
        }
        item.status = decision;
        item.note = note || null;
        item.decidedById = actor.id;
        item.decidedByLabel = actor.label;
        item.decidedAt = new Date().toISOString();
        audit(db, `approval.${decision}`, item.id, { projectId: item.projectId, note: item.note }, actor);
        return item;
      }),

    markLogin: (userId) =>
      update((db) => {
        const user = db.users.find((u) => u.id === userId);
        if (!user) return;
        user.lastLoginAt = new Date().toISOString();
      }),

    // --- audit / stats -----------------------------------------------------
    listAudit: (limit = 100) => view((db) => db.auditLogs.slice(0, Math.max(1, Math.min(limit, AUDIT_LIMIT)))),
    logAudit: (action, entityId, detail, actor) =>
      update((db) => {
        audit(db, action, entityId, detail, actor);
      }),
    getStats: () =>
      view((db) => ({
        projects: db.projects.length,
        tasks: db.projects.reduce((n, p) => n + p.tasks.length, 0),
        pendingApprovals: db.approvals.filter((a) => a.status === 'pending').length,
        completedTasks: db.projects.reduce((n, p) => n + p.tasks.filter((t) => t.status === 'completed').length, 0),
        auditEvents: db.auditLogs.length,
        users: db.users.length,
      })),
    snapshot: () => load(),
  };

  return store;
}
