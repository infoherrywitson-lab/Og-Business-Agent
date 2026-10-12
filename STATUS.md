# Implementation status (honest MVP scope)

## Implemented in this starter
- Local web dashboard and mobile-responsive UI.
- Natural-language project intake with basic English/Roman Urdu/Urdu-script detection.
- Deterministic multi-agent task plan and deliverable suggestions.
- Optional OpenAI-compatible JSON planning adapter; rules-based fallback if no key or provider failure.
- Local JSON persistence for projects, approval records, and audit events.
- Approval queue with approve/reject decisions and audit trail.
- Server-side AI key handling, request size limit, basic path traversal defense, CSP, input length limits.
- Node built-in tests for planner behavior.

## Implemented but not fully tested
- AI provider adapter against third-party compatible endpoints. Test it with your chosen provider and model.
- Local persistence under simultaneous multi-process writes. This starter is intended for one local process, not concurrent production workloads.

## Requires credentials / setup
- AI-assisted planning: `AI_API_KEY`, optionally `AI_BASE_URL` and `AI_MODEL`.
- Production database: use the supplied `supabase/schema.sql` and implement the production adapter before multi-user deployment.

## Not implemented
- Real social publishing, ad buying, website deployment, email/WhatsApp outreach, live SEO crawling, analytics provider sync, billing, workspace authentication, role-based access, secrets vault, distributed queue, and automated backups.
- Approving an item only records a decision. It does not execute any external action.

Do not expose this local starter directly to the public internet. It has no user authentication and stores data in a local JSON file.
