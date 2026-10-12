# Business OS — AI Business Command Center

A production-ready, approval-gated business command center. One natural-language brief — in **English, Urdu script or Roman Urdu** — becomes a saved project with specialist agents, a task plan, deliverables and a human approval queue, all with role-based access control and a full audit trail.

Free-first and self-hostable: **zero runtime npm dependencies**, plain Node.js built-ins only. Approving an item records a human decision; this system does not publish, spend, deploy or message anything by itself.

## Features

- **Natural-language intake** with English / Urdu-script / Roman-Urdu detection.
- **Deterministic multi-agent planner** (8 specialist agents) plus an optional **OpenAI-compatible AI adapter** that falls back automatically when no key or provider failure occurs.
- **Task tracking** with statuses, priorities, per-project progress and project lifecycle (`planning → active → completed`).
- **Approval queue** for external-action categories (publishing, ad spend, purchases, deployment, outreach) — decisions are one-shot, noted and audited.
- **Authentication & RBAC**: first-run workspace setup, scrypt-hashed passwords, HttpOnly sessions, failed-login lockout, and roles `viewer < member < admin` enforced on every route.
- **Team management**: admins invite users, change roles and deactivate accounts; the last active admin cannot be demoted.
- **Audit log** for every state change with the acting user and timestamp.
- **Hardening**: strict CSP (no inline scripts/styles), CSRF origin checks, per-IP rate limits with `429 + Retry-After`, body-size limits, path-traversal defence, security headers, structured request logging, graceful shutdown.
- **Crash-safe storage**: atomic fsync'd JSON writes, corrupt-file backup, legacy-schema migration, hourly session pruning.

## Quick start

```bash
cp .env.example .env        # optional: add AI_API_KEY for AI-assisted plans
npm start                   # or: bun run start  (node src/server.js)
```

Open http://127.0.0.1:3000 — the landing page leads to `/auth`, where the **first account becomes the workspace admin** and can invite the rest of the team.

### Scripts

| Script | Command | Purpose |
|---|---|---|
| `npm start` | `node src/server.js` | Run the server |
| `npm run dev` | `node --watch src/server.js` | Run with auto-reload |
| `npm test` | `node --test` | 25 unit + integration tests (planner, store, auth, API/security) |
| `npm run typecheck` | `tsc -b --noEmit` | Strict JSDoc typecheck of all sources |
| `npm run build` | `node scripts/build.js` | Stage a runnable copy into `dist/` and exit |

## Environment variables

Defined in `.env.example` for the basics; the server reads all of these:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Listen port (Freebuff injects it in preview/production) |
| `HOST` | `127.0.0.1` | Use `0.0.0.0` to accept external connections |
| `NODE_ENV` | `development` | `production` enables production behaviour |
| `DATA_DIR` | `data` | JSON database directory |
| `TRUST_PROXY` | `0` | `1` behind a reverse proxy (client IPs from `X-Forwarded-For`, HTTPS from `X-Forwarded-Proto`) |
| `BODY_LIMIT_BYTES` | `131072` | Max API request body |
| `SESSION_TTL_DAYS` | `7` | Session lifetime |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` (JSON lines on stdout) |
| `RATE_MAX` / `RATE_WINDOW_MS` | `300` / `60000` | General API rate limit per IP |
| `AUTH_RATE_MAX` / `AUTH_RATE_WINDOW_MS` | `30` / `900000` | Sign-in/setup attempts per IP |
| `PLAN_RATE_MAX` / `PLAN_RATE_WINDOW_MS` | `10` / `60000` | AI plan creations per user |
| `AI_API_KEY` | — | Optional: enables AI-assisted planning (server-side only) |
| `AI_BASE_URL` | `https://api.openai.com/v1` | Any OpenAI-compatible endpoint |
| `AI_MODEL` | `gpt-4o-mini` | Model name |
| `AI_TIMEOUT_MS` | `25000` | Provider timeout before falling back to rules |

Never put a real key in `public/`, client-side JavaScript, or source control.

## Roles & permissions

| Capability | viewer | member | admin |
|---|:---:|:---:|:---:|
| Read projects, plans, approvals, audit | ✅ | ✅ | ✅ |
| Create projects, update task status | ❌ | ✅ | ✅ |
| Decide approvals | ❌ | ❌ | ✅ |
| Manage team (invite, roles, deactivate) | ❌ | ❌ | ✅ |
| Delete projects | ❌ | ❌ | ✅ |

## API

All routes except `/api/health` and the auth routes require a session cookie. Mutations additionally require a same-origin `Origin` header (browser CSRF defence).

**Public**
- `GET /api/health` — liveness, version, whether an AI key is configured (never the key)
- `GET /api/auth/state` — `{ setupRequired }` (true only before the first admin exists)
- `POST /api/auth/setup` — first admin; locked once any user exists
- `POST /api/auth/login` / `POST /api/auth/logout`

**Authenticated**
- `GET /api/me` — current user
- `GET /api/stats` — counters
- `GET|POST /api/projects` — list / create from `{ name?, prompt }` (member+)
- `GET|DELETE /api/projects/:id` — read / admin delete
- `PATCH /api/projects/:id/tasks/:taskId` — `{ status: queued|in_progress|completed|blocked, output? }` (member+)
- `GET /api/approvals` · `POST /api/approvals/:id` — `{ decision: approved|rejected, note? }` (admin)
- `GET /api/audit?limit=` — recent events with actor
- `GET|POST /api/users` · `PATCH /api/users/:id` — team admin (admin only): `{ name?, email?, role?, password?, active? }`

Errors are `{ "error": "message" }` with proper status codes (`400/401/403/404/409/413/429`).

## Architecture

```
src/
  server.js    HTTP server: routing, auth enforcement, static delivery, shutdown
  config.js    environment-driven configuration
  auth.js      scrypt hashing, session tokens, RBAC rules
  security.js  CSP/security headers, rate limiter, login lockout
  store.js     atomic JSON persistence (users, sessions, projects, approvals, audit)
  planner.js   deterministic planner + OpenAI-compatible adapter with fallback
  util.js      responses, bounded body parsing, cookies, origin checks
  logger.js    JSON-line structured logging
public/        landing page, auth page, dashboard (no build step, strict CSP)
tests/         planner, store, auth and full API/security integration tests
supabase/      schema for a later multi-user Postgres deployment (not wired in)
scripts/       build.js — stages dist/ for production
```

### Storage

`data/db.json`, written atomically (temp file → fsync → rename) on every change. A corrupt file is preserved as `db.json.corrupt-<ts>` instead of being overwritten, and old MVP records migrate automatically on load. Back up `DATA_DIR` on a schedule. For multi-instance or multi-workspace deployments, move to Postgres using `supabase/schema.sql` and keep the store interface.

## Production deployment

- **Freebuff hosting**: install `bun install`, build `node scripts/build.js` (verified with `freebuff-deploy check`), preview command `HOST=0.0.0.0 node src/server.js`.
- Put TLS in front (Freebuff does this on hosted URLs) and set `TRUST_PROXY=1` behind a proxy.
- Set `HOST=0.0.0.0`, `NODE_ENV=production`, and back up `DATA_DIR`.
- Optional: set `AI_API_KEY` in the platform's environment/keys UI.

## Tests

```bash
npm test           # node --test — 25 tests
npm run typecheck  # strict JSDoc typecheck
```

Coverage: planner behaviour and language detection, AI fallback paths, atomic persistence/backup/migration, password & session handling, lockout, plus an integration suite that boots real servers to verify auth lifecycle, RBAC, approval one-shot semantics, CSRF origin rejection, path traversal defence, body limits, rate limiting, redirects and security headers.

## Status

**Implemented and tested:** everything listed above — dashboard, intake, planning, persistence, approvals, RBAC, audit, hardening, tests, CI (`.github/workflows/ci.yml`).

**Requires credentials (optional):** AI-assisted planning via `AI_API_KEY`.

**Not implemented (by design for this release):** real social publishing, ad buying, live analytics sync, billing, email delivery (password resets), distributed rate limiting/queue, automated backups. Approving an item only records a decision — it does not execute any external action. See [`docs/STATUS.md`](docs/STATUS.md).
