# Implementation status

## Implemented and tested

- **Web experience**: landing page, first-run workspace setup, sign-in, and a responsive command-center dashboard (dark theme, strict CSP — no inline scripts or styles).
- **Natural-language project intake** with English / Urdu-script / Roman-Urdu detection.
- **Deterministic multi-agent task plan** (8 specialist agents, priorities, deliverables, acceptance criteria) and **optional OpenAI-compatible AI adapter** with automatic rules-based fallback on missing key, timeout, or provider error.
- **Task tracking** with statuses and project lifecycle; per-project progress and workspace stats.
- **Approval queue** covering external-action categories; decisions are one-shot, note-carrying and admin-only.
- **Authentication**: first-run admin bootstrap, scrypt password hashing, HttpOnly SameSite session cookies (stored only as SHA-256 hashes), failed-login lockout, per-IP auth rate limits, logout invalidation, password-change session revocation.
- **Role-based access control**: `viewer < member < admin` enforced server-side on every route; team management API; last-active-admin protection.
- **Audit log** with actor on every state change (auth, project, task, approval, user events).
- **Hardening**: strict CSP, CSRF origin/`Sec-Fetch-Site` rejection, general/plan rate limits with `429 + Retry-After`, request body limits (`413`), static path-containment (`403`), security headers (nosniff, frame deny, referrer policy, permissions policy, COOP/CORP, HSTS behind TLS), bounded input validation, structured JSON request logging, request/timeouts and graceful shutdown.
- **Crash-safe persistence**: atomic fsync+rename JSON writes, corrupt-database backup, legacy-record migration, expired-session pruning.
- **Verification**: 25 automated tests (planner, store, auth, full API/security integration against real servers), strict JSDoc typecheck (`tsc -b --noEmit`), GitHub Actions CI, production build staging to `dist/`.
- **Deployment config**: Freebuff preview (`HOST=0.0.0.0 node src/server.js`), install `bun install`, build `node scripts/build.js` — `freebuff-deploy check` reports no problems.

## Requires credentials / setup

- AI-assisted planning: `AI_API_KEY` (plus optional `AI_BASE_URL`, `AI_MODEL`, `AI_TIMEOUT_MS`). Without them the deterministic planner is used.
- Production: TLS + `TRUST_PROXY=1` behind a proxy, `HOST=0.0.0.0`, backups of `DATA_DIR`.

## Not implemented (intentional)

- Real social publishing, ad buying, website deployment, email/WhatsApp outreach, live SEO crawling and analytics-provider sync — **approving an item only records a human decision; no external action is executed.**
- Billing/subscriptions, email-based password reset, multi-workspace SaaS tenancy, distributed (multi-process) rate limiting and job queue, automated backups, metrics/tracing exporters.
- The supplied `supabase/schema.sql` remains the documented path to a transactional multi-user database; RLS policies still need to be implemented and tested before that switch.

## Known single-process scope

Persistence and rate limiting are in-memory/on-disk for **one server process** (the intended deployment). Horizontal scaling requires a shared database and shared limiter/queue.
