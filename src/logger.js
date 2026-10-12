/**
 * Minimal structured logger: one JSON object per line on stdout.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * @param {import('./types.js').AppConfig['logLevel']} [level]
 * @returns {import('./types.js').Logger}
 */
export function createLogger(level = 'info') {
  const threshold = LEVELS[level] ?? LEVELS.info;

  /**
   * @param {'debug'|'info'|'warn'|'error'} lvl
   * @param {string} msg
   * @param {Record<string, unknown>} [meta]
   */
  const write = (lvl, msg, meta) => {
    if ((LEVELS[lvl] ?? 20) < threshold) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), level: lvl, msg, ...(meta || {}) });
    if (lvl === 'error') process.stderr.write(line + '\n');
    else process.stdout.write(line + '\n');
  };

  return {
    debug: (msg, meta) => write('debug', msg, meta),
    info: (msg, meta) => write('info', msg, meta),
    warn: (msg, meta) => write('warn', msg, meta),
    error: (msg, meta) => write('error', msg, meta),
  };
}

/** A logger that drops everything; handy default for tests. */
/** @type {import('./types.js').Logger} */
export const nullLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
