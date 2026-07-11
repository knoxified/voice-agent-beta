-- ─── Run this in your Supabase SQL editor ────────────────

-- Tenants table
create table if not exists tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  plan text not null default 'free' check (plan in ('free', 'starter', 'pro', 'enterprise')),
  minutes_remaining integer not null default 5,
  agent_persona text default 'professional receptionist',
  agent_greeting text default null,
  quota_exceeded_message text default null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Phone numbers table (each tenant can have multiple numbers)
create table if not exists phone_numbers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants(id) on delete cascade,
  number text not null unique,
  label text default 'main',
  active boolean default true,
  created_at timestamptz default now()
);

-- Call logs table
create table if not exists call_logs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants(id),
  call_control_id text,
  caller_number text,
  direction text check (direction in ('inbound', 'outbound')),
  duration_secs integer default 0,
  minutes_deducted integer default 0,
  started_at timestamptz default now(),
  ended_at timestamptz default null
);

-- ─── Atomic minute deduction (prevents race conditions) ───
-- This runs as a single DB operation so two simultaneous
-- end-of-call events can't double-deduct or go negative
create or replace function deduct_minutes(
  p_tenant_id uuid,
  p_minutes integer
)
returns void
language plpgsql
security definer
as $$
begin
  update tenants
  set
    minutes_remaining = greatest(0, minutes_remaining - p_minutes),
    updated_at = now()
  where id = p_tenant_id;
end;
$$;

-- ─── RLS policies ─────────────────────────────────────────
alter table tenants enable row level security;
alter table phone_numbers enable row level security;
alter table call_logs enable row level security;

-- Service role bypasses RLS (your Node.js server uses service key)
-- Users only see their own tenant data (for dashboard)
create policy "tenants_service_access" on tenants
  for all using (auth.role() = 'service_role');

create policy "phone_numbers_service_access" on phone_numbers
  for all using (auth.role() = 'service_role');

create policy "call_logs_service_access" on call_logs
  for all using (auth.role() = 'service_role');

-- ─── Test data — insert one tenant to test with ──────────
insert into tenants (id, name, plan, minutes_remaining, agent_persona, agent_greeting)
values (
  'a0000000-0000-0000-0000-000000000001',
  'Test Business',
  'pro',
  1000,
  'friendly receptionist',
  'Hello, thanks for calling Test Business. How can I help you today?'
);

-- Insert a test phone number (replace with your actual Telnyx number)
insert into phone_numbers (tenant_id, number, label)
values (
  'a0000000-0000-0000-0000-000000000001',
  '+12345678900',  -- replace with your Telnyx number
  'main'
);
