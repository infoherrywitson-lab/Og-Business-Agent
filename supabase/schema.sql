-- Production database starting point. Review and enable RLS policies before exposing through Supabase APIs.
create extension if not exists pgcrypto;
create table if not exists workspaces (
  id uuid primary key default gen_random_uuid(), name text not null, created_at timestamptz not null default now()
);
create table if not exists workspace_members (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null, role text not null check (role in ('owner','admin','member','viewer')),
  created_at timestamptz not null default now(), primary key(workspace_id,user_id)
);
create table if not exists brand_profiles (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null, website_url text, target_audience text, brand_voice text, locales text[] not null default '{}', created_at timestamptz not null default now()
);
create table if not exists projects (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references workspaces(id) on delete cascade,
  brand_profile_id uuid references brand_profiles(id) on delete set null, name text not null, original_prompt text not null,
  status text not null default 'planning', plan jsonb not null default '{}'::jsonb, created_by uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists tasks (
  id uuid primary key default gen_random_uuid(), project_id uuid not null references projects(id) on delete cascade,
  agent_role text not null, title text not null, description text, status text not null default 'queued', priority text not null default 'normal',
  attempts int not null default 0, idempotency_key text unique, input jsonb not null default '{}'::jsonb, output jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists task_dependencies (
  task_id uuid not null references tasks(id) on delete cascade, depends_on_task_id uuid not null references tasks(id) on delete cascade,
  primary key(task_id,depends_on_task_id), check(task_id <> depends_on_task_id)
);
create table if not exists artifacts (
  id uuid primary key default gen_random_uuid(), project_id uuid not null references projects(id) on delete cascade,
  task_id uuid references tasks(id) on delete set null, kind text not null, title text not null, current_version int not null default 1, created_at timestamptz not null default now()
);
create table if not exists artifact_versions (
  id uuid primary key default gen_random_uuid(), artifact_id uuid not null references artifacts(id) on delete cascade,
  version int not null, content jsonb not null, created_by text not null default 'agent', created_at timestamptz not null default now(), unique(artifact_id,version)
);
create table if not exists approvals (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade, task_id uuid references tasks(id) on delete cascade,
  action_type text not null, payload jsonb not null default '{}'::jsonb, status text not null default 'pending' check(status in ('pending','approved','rejected','expired')),
  requested_by text, decided_by uuid, decision_note text, created_at timestamptz not null default now(), decided_at timestamptz
);
create table if not exists integrations (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references workspaces(id) on delete cascade,
  provider text not null, status text not null default 'disconnected', scopes text[] not null default '{}', last_health_check timestamptz, created_at timestamptz not null default now(), unique(workspace_id,provider)
);
create table if not exists scheduled_jobs (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade, job_type text not null, payload jsonb not null default '{}'::jsonb,
  cron_expression text, run_at timestamptz, status text not null default 'scheduled', created_at timestamptz not null default now()
);
create table if not exists job_runs (
  id uuid primary key default gen_random_uuid(), scheduled_job_id uuid references scheduled_jobs(id) on delete set null,
  status text not null, started_at timestamptz not null default now(), finished_at timestamptz, error_code text, error_summary text, result jsonb
);
create table if not exists usage_events (
  id uuid primary key default gen_random_uuid(), workspace_id uuid references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null, provider text, model text, input_tokens int, output_tokens int,
  estimated_cost numeric(12,6) not null default 0, created_at timestamptz not null default now()
);
create table if not exists audit_logs (
  id uuid primary key default gen_random_uuid(), workspace_id uuid references workspaces(id) on delete cascade,
  actor_id uuid, action text not null, entity_type text, entity_id text, detail jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);
create index if not exists idx_projects_workspace_created on projects(workspace_id,created_at desc);
create index if not exists idx_tasks_project_status on tasks(project_id,status);
create index if not exists idx_approvals_workspace_status on approvals(workspace_id,status,created_at desc);
create index if not exists idx_scheduled_jobs_status_runat on scheduled_jobs(status,run_at);
-- SECURITY TODO: enable RLS on every workspace-owned table and add membership-based policies before production use.
