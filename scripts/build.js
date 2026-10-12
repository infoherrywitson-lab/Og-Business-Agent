/**
 * Production build. The app has no compile step (plain Node ESM), so "build"
 * stages a self-contained, runnable copy of the app into dist/ and exits —
 * it never starts a server (that is the preview/deploy runtime's job).
 *
 * Layout produced:
 *   dist/package.json   — start script runs the staged server
 *   dist/src/**         — server sources
 *   dist/public/**      — static UI
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

fs.cpSync(path.join(root, 'src'), path.join(dist, 'src'), { recursive: true });
fs.cpSync(path.join(root, 'public'), path.join(dist, 'public'), { recursive: true });

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const staged = {
  name: pkg.name,
  version: pkg.version,
  private: true,
  type: 'module',
  description: pkg.description,
  engines: pkg.engines,
  scripts: { start: 'node src/server.js' },
};
fs.writeFileSync(path.join(dist, 'package.json'), JSON.stringify(staged, null, 2) + '\n');

// Sanity check: the staged server must exist and resolve its assets.
const entry = path.join(dist, 'src', 'server.js');
if (!fs.existsSync(entry)) throw new Error('Build failed: staged server entry missing');
if (!fs.existsSync(path.join(dist, 'public', 'index.html'))) throw new Error('Build failed: staged landing page missing');

/**
 * @param {string} dir
 * @returns {number}
 */
const count = (dir) => fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? count(path.join(dir, e.name)) : 1), 0);
console.log(JSON.stringify({
  ok: true,
  out: 'dist/',
  files: count(dist),
  entry: 'dist/src/server.js',
  static: 'dist/public/',
}));
