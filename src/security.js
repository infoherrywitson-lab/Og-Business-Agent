/**
 * Security middleware: response hardening headers and rate limiting.
 */

import { isHttps } from './util.js';

/**
 * Content-Security-Policy without 'unsafe-inline': all scripts and styles are
 * served as files, so no inline handlers are allowed anywhere in the UI.
 */
export const CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "img-src 'self' data:",
  "style-src 'self'",
  "script-src 'self'",
  "connect-src 'self'",
  "font-src 'self'",
].join('; ');

/**
 * Apply baseline security headers to every response.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {boolean} trustProxy
 */
export function applySecurityHeaders(req, res, trustProxy) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (isHttps(req, trustProxy)) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

/**
 * Fixed-window in-memory rate limiter. Keys are client IPs (or IP+email for
 * login). A single-process limiter is correct for this single-process server;
 * a distributed deployment should move this to a shared store.
 *
 * @param {{windowMs: number, max: number}} opts
 */
export function createRateLimiter(opts) {
  /** @type {Map<string, {count: number, resetAt: number}>} */
  const hits = new Map();

  /**
   * @param {string} key
   * @param {number} [now]
   * @returns {{allowed: boolean, limit: number, remaining: number, retryAfter: number}}
   */
  return function check(key, now = Date.now()) {
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + opts.windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (hits.size > 20_000) {
      for (const [k, v] of hits) {
        if (v.resetAt <= now) hits.delete(k);
      }
    }
    const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    return {
      allowed: entry.count <= opts.max,
      limit: opts.max,
      remaining: Math.max(0, opts.max - entry.count),
      retryAfter,
    };
  };
}

/**
 * Rate-limit headers for a check result.
 * @param {{allowed: boolean, limit: number, remaining: number, retryAfter: number}} result
 * @returns {Record<string, string>}
 */
export function rateHeaders(result) {
  return {
    'X-RateLimit-Limit': String(result.limit),
    'X-RateLimit-Remaining': String(result.remaining),
    ...(result.allowed ? {} : { 'Retry-After': String(result.retryAfter) }),
  };
}

/**
 * Failed-login guard: tracks failures per ip+email and locks the key briefly.
 * @param {{maxFails?: number, windowMs?: number, lockoutMs?: number}} [opts]
 */
export function createLoginGuard(opts = {}) {
  const maxFails = opts.maxFails ?? 8;
  const windowMs = opts.windowMs ?? 15 * 60_000;
  const lockoutMs = opts.lockoutMs ?? 15 * 60_000;
  /** @type {Map<string, {fails: number, firstAt: number, lockedUntil: number}>} */
  const keys = new Map();

  return {
    /**
     * @param {string} key
     * @param {number} [now]
     * @returns {number} seconds until the key unlocks (0 when not locked)
     */
    lockedFor(key, now = Date.now()) {
      const entry = keys.get(key);
      if (!entry || entry.lockedUntil <= now) return 0;
      return Math.max(1, Math.ceil((entry.lockedUntil - now) / 1000));
    },
    /**
     * @param {string} key
     * @param {number} [now]
     */
    fail(key, now = Date.now()) {
      let entry = keys.get(key);
      if (!entry || now - entry.firstAt > windowMs) {
        entry = { fails: 0, firstAt: now, lockedUntil: 0 };
        keys.set(key, entry);
      }
      entry.fails += 1;
      if (entry.fails >= maxFails) entry.lockedUntil = now + lockoutMs;
      if (keys.size > 20_000) {
        for (const [k, v] of keys) {
          if (now - v.firstAt > windowMs && v.lockedUntil <= now) keys.delete(k);
        }
      }
    },
    /**
     * @param {string} key
     */
    succeed(key) {
      keys.delete(key);
    },
  };
}
