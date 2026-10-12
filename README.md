# Business OS MVP — AI Business Command Center

A real, minimal starter for turning a natural-language business brief into a saved project, agent/task plan, deliverables checklist, and human approval queue. It is free-first and runs on Node.js without npm dependencies.

> **Important:** This is a local MVP starter, not a complete production SaaS. It does not publish to social platforms, buy ads, deploy websites, send messages, or execute external actions. Approvals only record a human decision. See [`docs/STATUS.md`](docs/STATUS.md).

## Requirements
- Node.js 20 or newer
- Optional AI provider API key for AI-assisted planning

## Run locally

```bash
cp .env.example .env
# Optional: edit .env and add AI_API_KEY, AI_BASE_URL, AI_MODEL
npm start
```

Open http://127.0.0.1:3000. No `npm install` is required. If you don't configure an AI key, the deterministic rules-based planner still works.

### Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `AI_API_KEY` | No | Server-side key for an OpenAI-compatible chat-completions endpoint |
| `AI_BASE_URL` | No | Defaults to `https://api.openai.com/v1` |
| `AI_MODEL` | No | Defaults to `gpt-4o-mini` |
| `HOST` | No | Defaults to `127.0.0.1` (local-only) |
| `PORT` | No | Defaults to `3000` |

Never place a real key in `public/`, client-side JavaScript, or source control. Keep `HOST=127.0.0.1` unless you add authentication and security controls.

## Tests

```bash
npm test
```

The tests cover planner behavior. They do not constitute a full security, load, or end-to-end audit.

## API

- `GET /api/health` — status and whether an AI key is configured (never reveals the key)
- `GET /api/stats` — summary counters
- `GET /api/projects` — saved projects
- `POST /api/projects` — `{ "name": "Optional", "prompt": "Describe what you want to build" }`
- `GET /api/projects/:id` — one project
- `GET /api/approvals` — approval records
- `POST /api/approvals/:id` — `{ "decision": "approved" | "rejected", "note": "Optional" }`
- `GET /api/audit` — recent audit events

## Architecture

- `src/planner.js`: deterministic multi-agent planner plus optional AI-provider adapter.
- `src/store.js`: atomic-file JSON persistence for a single local process.
- `src/server.js`: Node HTTP server, API routes, static serving and basic response protections.
- `public/`: responsive dashboard and client UI.
- `supabase/schema.sql`: starting schema for a later multi-user Supabase implementation. It is not connected to this local MVP, and RLS policies still need to be implemented and tested.

## Before production deployment

1. Implement authentication, workspace authorization and role-based access.
2. Replace local JSON storage with a transactional database; enable and test RLS policies.
3. Add a durable worker/queue with retries, idempotency and dead-letter handling.
4. Add integration adapters and real health checks for each provider. Store OAuth tokens/secrets in a proper secret store.
5. Add SSRF controls, rate limits, quotas, content moderation, backups, observability, CI, and E2E/security tests.
6. Keep publishing, ad spend, purchases, deployments, and bulk outreach behind explicit approvals.
7. Validate platform API permissions and policies before connecting Facebook, Instagram, TikTok, YouTube, or other providers.

## Current status

- **IMPLEMENTED AND TESTABLE:** local dashboard, brief intake, task plan, local persistence, approval records, audit log, basic tests.
- **IMPLEMENTED BUT NOT FULLY TESTED:** optional OpenAI-compatible provider adapter.
- **REQUIRES CREDENTIALS:** AI-assisted planning.
- **NOT IMPLEMENTED:** external publishing, real analytics, billing, multi-user auth, production database adapter, distributed worker, deployment automation.
