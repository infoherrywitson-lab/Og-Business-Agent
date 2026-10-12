/**
 * Password hashing (Node's built-in scrypt), session tokens and input policy.
 * No third-party dependencies: everything here is Node crypto primitives.
 */

import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = /** @type {(password: import('node:crypto').BinaryLike, salt: import('node:crypto').BinaryLike, keylen: number, options: import('node:crypto').ScryptOptions) => Promise<Buffer>} */ (
  /** @type {unknown} */ (promisify(crypto.scrypt))
);

const SCRYPT_OPTS = /** @type {const} */ ({ N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const KEY_LEN = 64;

/**
 * Hash a password as `scrypt$N$r$p$salt$hash`.
 * @param {string} password
 * @returns {Promise<string>}
 */
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, KEY_LEN, SCRYPT_OPTS);
  return `scrypt$${SCRYPT_OPTS.N}$${SCRYPT_OPTS.r}$${SCRYPT_OPTS.p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

/**
 * Constant-time password verification. Returns false on any malformed hash.
 * @param {string} password
 * @param {string} stored
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number.parseInt(parts[1], 10);
  const r = Number.parseInt(parts[2], 10);
  const p = Number.parseInt(parts[3], 10);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  try {
    const salt = Buffer.from(parts[4], 'base64');
    const expected = Buffer.from(parts[5], 'base64');
    const derived = await scrypt(password, salt, expected.length, { N, r, p, maxmem: 64 * 1024 * 1024 });
    return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/**
 * Create an opaque session token. Only its SHA-256 hash is stored.
 * @returns {{token: string, tokenHash: string}}
 */
export function createSessionToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

/**
 * @param {string} token
 * @returns {string}
 */
export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * @param {unknown} email
 * @returns {boolean}
 */
export function isValidEmail(email) {
  return typeof email === 'string' && email.length <= 254 && EMAIL_RE.test(email);
}

const COMMON_PASSWORDS = new Set([
  'password12', 'password123', 'password1234', '1234567890', '12345678901', 'qwertyuiop',
  'letmein123', 'iloveyou12', 'welcome123', 'admin12345', 'businessos', 'changeme123',
]);

/**
 * Password policy: length first (the strongest single predictor), plus a
 * blocklist of well-known choices.
 * @param {unknown} password
 * @returns {string|null} problem description, or null when acceptable
 */
export function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < 10) {
    return 'Password must be at least 10 characters long.';
  }
  if (password.length > 200) return 'Password must be at most 200 characters long.';
  if (COMMON_PASSWORDS.has(password.toLowerCase())) return 'That password is too common. Choose something less guessable.';
  if (/^\s|\s$/.test(password)) return 'Password must not start or end with whitespace.';
  return null;
}

/**
 * The single ordering used for every permission check:
 * viewer < member < admin.
 * @param {import('./types.js').Role} role
 */
export function roleRank(role) {
  if (role === 'admin') return 3;
  if (role === 'member') return 2;
  return 1;
}

/**
 * @param {import('./types.js').Role|null|undefined} role
 * @param {import('./types.js').Role} required
 */
export function roleAtLeast(role, required) {
  if (!role) return false;
  return roleRank(role) >= roleRank(required);
}
