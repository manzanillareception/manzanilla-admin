-- Email/provisioning schema for the /api/v1 contract v1 (migration request #1, email lane). REV 2.
-- Baseline 202611090001 is immutable; this file is additive. Conventions preserved:
-- RLS on every table, no anonymous grants, no authenticated-client mutations,
-- service-role authorization is application responsibility, admin reads via private.is_enabled_admin().
-- Local disposable-Postgres tests must stub the Supabase auth schema (auth.users, auth.uid(), auth.jwt()).
begin;

create extension if not exists citext;

-- Hotel sign-in accounts. A hotel user must never be an internal admin (enforced below).
create table public.hotel_users (
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  auth_user_id uuid not null unique references auth.users(id) on delete cascade,
  email citext not null unique,
  created_at timestamptz not null default now(),
  primary key (hotel_id, auth_user_id)
);

create or replace function private.reject_admin_hotel_user()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if exists (select 1 from public.admin_members m where m.user_id = new.auth_user_id) then
    raise exception 'hotel user cannot be an admin';
  end if;
  return new;
end $$;
revoke all on function private.reject_admin_hotel_user() from public, anon;
grant execute on function private.reject_admin_hotel_user() to service_role;

create trigger hotel_users_not_admin before insert or update on public.hotel_users
  for each row execute function private.reject_admin_hotel_user();

-- Durable provisioning jobs. Server-only: sealed passwords never enter admin reads or exports.
-- 'alert' is NOT a job kind: alert emails are tracked in public.alert_notifications.
create table private.provisioning_jobs (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id),
  email citext not null,
  kind text not null check (kind in ('welcome', 'guide', 'recovery')),
  status text not null default 'pending' check (status in ('pending', 'auth_created', 'sent', 'needs_attention', 'done')),
  auth_user_id uuid references auth.users(id),
  sealed_password text,
  deadline_at timestamptz not null,
  lease_owner text,
  lease_until timestamptz,
  provider_message_id text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- One active job per (hotel, kind). needs_attention is terminal for claiming; an operator
-- retry requeues the SAME row (private.requeue_provisioning_job), so the index stays correct.
create unique index provisioning_jobs_one_active on private.provisioning_jobs (hotel_id, kind)
  where status in ('pending', 'auth_created', 'sent');
revoke all on private.provisioning_jobs from public, anon, authenticated;
grant select, insert, update on private.provisioning_jobs to service_role;

-- Atomic lease claim: one worker wins; expired leases are reclaimable.
-- needs_attention is NOT claimable (review item 1): it is terminal until an operator requeues.
create or replace function private.claim_provisioning_job(p_job_id uuid, p_worker text, p_lease_seconds int)
returns uuid language plpgsql security definer set search_path = ''
as $$
begin
  update private.provisioning_jobs
     set lease_owner = p_worker,
         lease_until = now() + make_interval(secs => greatest(p_lease_seconds, 1)),
         updated_at = now()
   where id = p_job_id
     and status in ('pending', 'auth_created')
     and (lease_until is null or lease_until < now());
  if found then return p_job_id; end if;
  return null;
end $$;
revoke all on function private.claim_provisioning_job(uuid, text, int) from public, anon, authenticated;
grant execute on function private.claim_provisioning_job(uuid, text, int) to service_role;

-- Fenced stage write (review item 5 + rev3 transition guards): every stage transition re-checks
-- the caller's lease. A lost or expired lease writes zero rows. Only legal transitions apply:
-- pending -> auth_created|sent|needs_attention; auth_created -> sent|needs_attention;
-- sent -> done|needs_attention. needs_attention and done are terminal for stage writes
-- (requeue moves needs_attention back to pending). Parameters are keep-if-null except
-- sealed_password (changes only when p_set_sealed is true; pass NULL to wipe) and last_error
-- (cleared only when p_clear_error is true).
create or replace function private.provisioning_stage_write(
  p_job_id uuid, p_worker text, p_status text,
  p_auth_user_id uuid default null, p_sealed_password text default null,
  p_set_sealed boolean default false, p_provider_message_id text default null,
  p_last_error text default null, p_clear_error boolean default false)
returns boolean language plpgsql security definer set search_path = ''
as $$
begin
  update private.provisioning_jobs
     set status = p_status,
         auth_user_id = coalesce(p_auth_user_id, auth_user_id),
         sealed_password = case when p_set_sealed then p_sealed_password else sealed_password end,
         provider_message_id = coalesce(p_provider_message_id, provider_message_id),
         last_error = case when p_clear_error then null else coalesce(p_last_error, last_error) end,
         updated_at = now()
   where id = p_job_id
     and lease_owner = p_worker
     and lease_until is not null and lease_until > now()
     and case status
           when 'pending' then p_status in ('auth_created', 'sent', 'needs_attention')
           when 'auth_created' then p_status in ('sent', 'needs_attention')
           when 'sent' then p_status in ('done', 'needs_attention')
           else false end;
  return found;
end $$;
revoke all on function private.provisioning_stage_write(uuid, text, text, uuid, text, boolean, text, text, boolean) from public, anon, authenticated;
grant execute on function private.provisioning_stage_write(uuid, text, text, uuid, text, boolean, text, text, boolean) to service_role;

-- Fenced release: only the lease holder may release.
create or replace function private.release_provisioning_job(p_job_id uuid, p_worker text)
returns boolean language plpgsql security definer set search_path = ''
as $$
begin
  update private.provisioning_jobs
     set lease_owner = null, lease_until = null, updated_at = now()
   where id = p_job_id and lease_owner = p_worker;
  return found;
end $$;
revoke all on function private.release_provisioning_job(uuid, text) from public, anon, authenticated;
grant execute on function private.release_provisioning_job(uuid, text) to service_role;

-- Operator retry of a terminal needs_attention job: same row back to pending, lease/error cleared.
-- deadline_at is intentionally NOT extended; requeue inside the original window only.
create or replace function private.requeue_provisioning_job(p_job_id uuid)
returns boolean language plpgsql security definer set search_path = ''
as $$
begin
  update private.provisioning_jobs
     set status = 'pending', lease_owner = null, lease_until = null, last_error = null, updated_at = now()
   where id = p_job_id and status = 'needs_attention';
  return found;
end $$;
revoke all on function private.requeue_provisioning_job(uuid) from public, anon, authenticated;
grant execute on function private.requeue_provisioning_job(uuid) to service_role;

-- Non-secret job status for the admin dashboard (welcome/recovery delivery state).
-- Security definer over the private table; enabled-admin predicate inside (tightened to aal2
-- by migration 202611100002's is_enabled_admin replacement).
create or replace function public.provisioning_job_status(p_hotel_id uuid default null)
returns table (id uuid, hotel_id uuid, email citext, kind text, status text,
               provider_message_id text, last_error text, created_at timestamptz, updated_at timestamptz)
language sql stable security definer set search_path = ''
as $$
  select j.id, j.hotel_id, j.email, j.kind, j.status, j.provider_message_id,
         j.last_error, j.created_at, j.updated_at
  from private.provisioning_jobs j
  where (p_hotel_id is null or j.hotel_id = p_hotel_id)
    and (select private.is_enabled_admin());
$$;
revoke all on function public.provisioning_job_status(uuid) from public, anon;
grant execute on function public.provisioning_job_status(uuid) to authenticated, service_role;

-- One row per provider message. The send path inserts this row immediately after provider
-- acceptance, BEFORE returning (review item 2): a webhook for an unknown id is a 500 so Resend
-- retries; the webhook never upserts and never invents kind.
create table public.email_deliveries (
  provider_message_id text primary key,
  job_id uuid references private.provisioning_jobs(id),
  kind text not null check (kind in ('welcome', 'guide', 'recovery', 'alert')),
  state text not null default 'queued' check (state in ('queued', 'accepted', 'delayed', 'delivered', 'bounced', 'failed', 'complained')),
  last_event_at timestamptz not null default now()
);

-- Rank-ordered state advance (review item 3): single conditional UPDATE, no read-then-write race.
-- delivered(3) cannot regress to delayed(2); bounced/failed(4) are terminal per message id.
create or replace function private.delivery_rank(p_state text)
returns int language sql immutable as $$
  select case p_state when 'queued' then 0 when 'accepted' then 1 when 'delayed' then 2
                      when 'delivered' then 3 when 'bounced' then 4 when 'failed' then 4
                      when 'complained' then 4 else -1 end
$$;
revoke all on function private.delivery_rank(text) from public, anon;
grant execute on function private.delivery_rank(text) to service_role;

create or replace function private.advance_email_delivery(p_id text, p_state text, p_event_at timestamptz)
returns text language plpgsql security definer set search_path = ''
as $$
declare v_state text;
begin
  update public.email_deliveries
     set state = p_state, last_event_at = greatest(last_event_at, p_event_at)
   where provider_message_id = p_id
     and private.delivery_rank(state) < private.delivery_rank(p_state)
  returning state into v_state;
  if found then return v_state; end if;
  select state into v_state from public.email_deliveries where provider_message_id = p_id;
  return v_state; -- null = unknown id: the webhook caller returns 500 so Resend retries
end $$;
revoke all on function private.advance_email_delivery(text, text, timestamptz) from public, anon, authenticated;
grant execute on function private.advance_email_delivery(text, text, timestamptz) to service_role;

-- Webhook dedupe (review item 4: DELETE granted so the retention job can purge).
create table private.webhook_events (
  svix_id text primary key,
  received_at timestamptz not null default now()
);
revoke all on private.webhook_events from public, anon, authenticated;
grant select, insert, delete on private.webhook_events to service_role;

-- Incident alert notifications (review item 7). Human acknowledgement is separate from delivery.
create table public.alert_notifications (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references public.incidents(id),
  recipient text not null,
  state text not null default 'pending' check (state in ('pending', 'sent', 'delivered', 'bounced', 'failed')),
  attempts int not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz,
  acked_by uuid references auth.users(id),
  acked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (incident_id, recipient)
);
create index alert_notifications_incident_idx on public.alert_notifications(incident_id);

-- Rank-ordered alert delivery advance; pending(0) < sent(1) < delivered(2) < bounced/failed(3).
create or replace function private.advance_alert_notification(p_id uuid, p_state text)
returns text language plpgsql security definer set search_path = ''
as $$
declare v_state text;
begin
  update public.alert_notifications
     set state = p_state
   where id = p_id
     and (case state when 'pending' then 0 when 'sent' then 1 when 'delivered' then 2
                     when 'bounced' then 3 when 'failed' then 3 else -1 end)
       < (case p_state when 'pending' then 0 when 'sent' then 1 when 'delivered' then 2
                       when 'bounced' then 3 when 'failed' then 3 else -1 end)
  returning state into v_state;
  if found then return v_state; end if;
  select state into v_state from public.alert_notifications where id = p_id;
  return v_state;
end $$;
revoke all on function private.advance_alert_notification(uuid, text) from public, anon, authenticated;
grant execute on function private.advance_alert_notification(uuid, text) to service_role;

alter table public.hotel_users enable row level security;
alter table public.email_deliveries enable row level security;
alter table public.alert_notifications enable row level security;

create policy enabled_admin_read on public.hotel_users for select to authenticated
  using ((select private.is_enabled_admin()));
create policy enabled_admin_read on public.email_deliveries for select to authenticated
  using ((select private.is_enabled_admin()));
create policy enabled_admin_read on public.alert_notifications for select to authenticated
  using ((select private.is_enabled_admin()));

commit;
