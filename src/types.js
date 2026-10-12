/**
 * Shared JSDoc type definitions for the Business OS backend.
 * This module is types-only; it exports nothing at runtime.
 */

export {};

/**
 * @typedef {'admin'|'member'|'viewer'} Role
 */

/**
 * @typedef {Object} User
 * @property {string} id
 * @property {string} email
 * @property {string} name
 * @property {Role} role
 * @property {string} passwordHash
 * @property {boolean} active
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {string|null} lastLoginAt
 */

/**
 * @typedef {Object} Session
 * @property {string} tokenHash
 * @property {string} userId
 * @property {string} createdAt
 * @property {string} expiresAt
 * @property {string} lastSeenAt
 * @property {string} ip
 */

/**
 * @typedef {'queued'|'in_progress'|'completed'|'blocked'} TaskStatus
 */

/**
 * @typedef {Object} PlanTask
 * @property {string} id
 * @property {string} agent
 * @property {string} role
 * @property {string} title
 * @property {string} description
 * @property {TaskStatus} status
 * @property {'high'|'normal'} priority
 * @property {boolean} requiresApproval
 * @property {string|null} output
 */

/**
 * @typedef {Object} Plan
 * @property {string} projectName
 * @property {string} summary
 * @property {string} languageDetected
 * @property {string[]} deliverables
 * @property {string[]} acceptanceCriteria
 * @property {PlanTask[]} tasks
 * @property {Record<string, string>} safety
 * @property {string[]} [risks]
 * @property {string[]} [recommendedAgents]
 * @property {string} [planningMode]
 * @property {string} [aiNote]
 */

/**
 * @typedef {Object} Task
 * @property {string} id
 * @property {string} projectId
 * @property {string} agent
 * @property {string} role
 * @property {string} title
 * @property {string} description
 * @property {TaskStatus} status
 * @property {'high'|'normal'} priority
 * @property {boolean} requiresApproval
 * @property {string|null} output
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {Object} Project
 * @property {string} id
 * @property {string} name
 * @property {string} prompt
 * @property {Plan} plan
 * @property {'planning'|'active'|'completed'|'archived'} status
 * @property {string} createdById
 * @property {string} createdByLabel
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {Task[]} tasks
 */

/**
 * @typedef {Object} Approval
 * @property {string} id
 * @property {string} projectId
 * @property {string} taskId
 * @property {string} title
 * @property {string} description
 * @property {'pending'|'approved'|'rejected'} status
 * @property {string} requestedById
 * @property {string} requestedByLabel
 * @property {string|null} decidedById
 * @property {string|null} decidedByLabel
 * @property {string|null} note
 * @property {string} createdAt
 * @property {string|null} decidedAt
 */

/**
 * @typedef {Object} AuditEvent
 * @property {string} id
 * @property {string} action
 * @property {string} entityId
 * @property {string} actorId
 * @property {string} actorLabel
 * @property {Record<string, unknown>} detail
 * @property {string} createdAt
 */

/**
 * @typedef {Object} DB
 * @property {number} version
 * @property {User[]} users
 * @property {Session[]} sessions
 * @property {Project[]} projects
 * @property {Approval[]} approvals
 * @property {AuditEvent[]} auditLogs
 */

/**
 * @typedef {Object} Actor
 * @property {string} id
 * @property {string} label
 * @property {Role} role
 */

/**
 * @typedef {Object} AppConfig
 * @property {number} port
 * @property {string} host
 * @property {string} dataDir
 * @property {string} publicDir
 * @property {'development'|'production'} env
 * @property {boolean} trustProxy
 * @property {number} bodyLimitBytes
 * @property {number} sessionTtlMs
 * @property {{windowMs: number, max: number, authWindowMs: number, authMax: number, planWindowMs: number, planMax: number}} rate
 * @property {{apiKey: string|null, baseUrl: string, model: string, timeoutMs: number}} ai
 * @property {'debug'|'info'|'warn'|'error'} logLevel
 */

/**
 * @typedef {Object} Logger
 * @property {(msg: string, meta?: Record<string, unknown>) => void} debug
 * @property {(msg: string, meta?: Record<string, unknown>) => void} info
 * @property {(msg: string, meta?: Record<string, unknown>) => void} warn
 * @property {(msg: string, meta?: Record<string, unknown>) => void} error
 */
