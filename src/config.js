import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Runtime configuration. Every value is derived from the environment so the
 * same artifact runs locally, in preview, and in production.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} name
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 */
function intEnv(env, name, fallback, min, max) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} name
 * @param {boolean} fallback
 */
function boolEnv(env, name, fallback) {
  const raw = (env[name] || '').toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {import('./types.js').AppConfig}
 */
export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV === 'production' ? 'production' : 'development';
  const dataDir = path.resolve(projectRoot, env.DATA_DIR && env.DATA_DIR.trim() ? env.DATA_DIR : 'data');
  const aiKey = env.AI_API_KEY && env.AI_API_KEY.trim() ? env.AI_API_KEY.trim() : null;

  return {
    port: intEnv(env, 'PORT', 3000, 1, 65535),
    host: (env.HOST || '127.0.0.1').trim(),
    dataDir,
    publicDir: path.join(projectRoot, 'public'),
    env: nodeEnv,
    trustProxy: boolEnv(env, 'TRUST_PROXY', false),
    bodyLimitBytes: intEnv(env, 'BODY_LIMIT_BYTES', 131_072, 1024, 5_242_880),
    sessionTtlMs: intEnv(env, 'SESSION_TTL_DAYS', 7, 1, 90) * 24 * 60 * 60 * 1000,
    rate: {
      windowMs: intEnv(env, 'RATE_WINDOW_MS', 60_000, 1000, 3_600_000),
      max: intEnv(env, 'RATE_MAX', 300, 10, 100_000),
      authWindowMs: intEnv(env, 'AUTH_RATE_WINDOW_MS', 900_000, 1000, 3_600_000),
      authMax: intEnv(env, 'AUTH_RATE_MAX', 30, 3, 10_000),
      planWindowMs: intEnv(env, 'PLAN_RATE_WINDOW_MS', 60_000, 1000, 3_600_000),
      planMax: intEnv(env, 'PLAN_RATE_MAX', 10, 1, 10_000),
    },
    ai: {
      apiKey: aiKey,
      baseUrl: (env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
      model: env.AI_MODEL || 'gpt-4o-mini',
      timeoutMs: intEnv(env, 'AI_TIMEOUT_MS', 25_000, 1000, 120_000),
    },
    logLevel: env.LOG_LEVEL === 'debug' || env.LOG_LEVEL === 'warn' || env.LOG_LEVEL === 'error'
      ? env.LOG_LEVEL
      : 'info',
  };
}
