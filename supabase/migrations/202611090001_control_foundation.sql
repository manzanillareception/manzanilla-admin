-- Unapplied Supabase foundation. Test in a disposable project before any pilot.
-- No production adapter/RPC, device ingress endpoint or provider broker is added here.
begin;

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated, service_role;

create table public.admin_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  enabled boolean not null default false,
  created_at timestamptz not null default now()
);

create or replace function private.is_enabled_admin()
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.admin_members m
    where m.user_id = (select auth.uid()) and m.enabled
  );
$$;
revoke all on function private.is_enabled_admin() from public, anon;
grant execute on function private.is_enabled_admin() to authenticated, service_role;

create table public.hotels (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 120),
  city text not null check (length(city) between 1 and 120),
  created_at timestamptz not null default now()
);

create table public.devices (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id),
  code text not null unique check (code ~ '^[A-Z0-9_-]{1,40}$'),
  label text not null check (length(label) between 1 and 80),
  build text not null check (build ~ '^[0-9]{1,4}(\.[0-9]{1,4}){0,3}$'),
  managed boolean not null default false,
  credential_state text not null default 'valid' check (credential_state in ('valid', 'revoked')),
  desired_access text not null default 'pending' check (desired_access in ('pending', 'approved', 'blocked')),
  effective_access text not null default 'pending' check (effective_access in ('pending', 'approved', 'blocked')),
  policy_revision bigint not null default 1 check (policy_revision > 0),
  ack_revision bigint not null default 0 check (ack_revision between 0 and policy_revision),
  policy_changed_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  last_seen_at timestamptz,
  enrolled_at timestamptz not null default now(),
  microphone text not null default 'unknown' check (microphone in ('granted', 'denied', 'unknown')),
  mode text not null default 'idle' check (mode in ('idle', 'translation', 'reception')),
  unique (id, hotel_id)
);
create index devices_hotel_idx on public.devices(hotel_id);
create index devices_presence_idx on public.devices(last_seen_at);

-- No authenticated-client SELECT grant, even for admins. Hashes never enter dashboard exports.
create table private.device_credentials (
  device_id uuid primary key references public.devices(id),
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  issued_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table public.voice_sessions (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.devices(id),
  feature text not null check (feature in ('translation', 'reception')),
  state text not null check (state in ('creating', 'ready', 'connected', 'stopping', 'ended', 'unknown')),
  started_at timestamptz not null,
  connected_at timestamptz,
  ended_at timestamptz,
  duration_ms bigint check (duration_ms between 0 and 86400000),
  duration_provenance text not null default 'unknown' check (duration_provenance in ('observed', 'estimated', 'unknown')),
  policy_revision bigint not null check (policy_revision > 0),
  unique (id, device_id),
  check (ended_at is null or ended_at >= started_at),
  check (connected_at is null or connected_at >= started_at)
);
create index voice_sessions_device_time_idx on public.voice_sessions(device_id, started_at);

-- Provider handles / token material are server-only; do not store reusable tokens here.
create table private.provider_calls (
  session_id uuid primary key references public.voice_sessions(id),
  provider text not null check (provider in ('openai', 'cartesia')),
  provider_call_id text check (length(provider_call_id) between 1 and 256),
  termination_state text not null default 'not_requested' check (termination_state in ('not_requested', 'pending', 'confirmed', 'unknown')),
  last_checked_at timestamptz
);

create table public.session_attempts (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null,
  device_id uuid not null,
  attempt_number integer not null check (attempt_number between 1 and 1000),
  started_at timestamptz not null,
  connected_at timestamptz,
  ended_at timestamptz,
  outcome text not null check (outcome in ('completed', 'failed', 'active')),
  first_audio_ms integer check (first_audio_ms between 0 and 120000),
  failure_code text check (failure_code in ('CONNECTION_TIMEOUT', 'MIC_PERMISSION_DENIED', 'PROVIDER_UNAVAILABLE', 'AUDIO_STARTUP_TIMEOUT', 'POLICY_SYNC_FAILED')),
  foreign key (session_id, device_id) references public.voice_sessions(id, device_id),
  unique (session_id, attempt_number),
  check (ended_at is null or ended_at >= started_at)
);

-- Exact ingress schema is validated by the server before these bounded columns.
-- No arbitrary JSON, log body, transcript, prompt or free-form device message.
create table public.technical_events (
  device_id uuid not null references public.devices(id),
  event_id uuid not null,
  boot_id uuid not null,
  sequence bigint not null check (sequence between 0 and 2147483647),
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  kind text not null check (kind in ('session.started', 'session.connected', 'session.ended', 'connection.failed', 'policy.ack', 'diagnostic.snapshot')),
  build text not null check (build ~ '^[0-9]{1,4}(\.[0-9]{1,4}){0,3}$'),
  feature text check (feature in ('translation', 'reception')),
  session_reference text check (session_reference ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$'),
  attempt_reference text check (attempt_reference ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$'),
  error_code text check (error_code in ('CONNECTION_TIMEOUT', 'MIC_PERMISSION_DENIED', 'PROVIDER_UNAVAILABLE', 'AUDIO_STARTUP_TIMEOUT', 'POLICY_SYNC_FAILED')),
  duration_ms bigint check (duration_ms between 0 and 86400000),
  duration_provenance text check (duration_provenance in ('observed', 'estimated')),
  first_audio_ms integer check (first_audio_ms between 0 and 120000),
  policy_revision bigint check (policy_revision between 1 and 2147483647),
  microphone text check (microphone in ('granted', 'denied', 'unknown')),
  battery_percent integer check (battery_percent between 0 and 100),
  free_memory_mb integer check (free_memory_mb between 0 and 1048576),
  primary key (device_id, event_id)
);
create index technical_events_time_idx on public.technical_events(received_at);

create table public.traffic_buckets (
  device_id uuid not null references public.devices(id),
  bucket_at timestamptz not null,
  requests bigint not null check (requests >= 0),
  failed_requests bigint not null check (failed_requests between 0 and requests),
  retry_requests bigint not null check (retry_requests between 0 and requests),
  ingress_bytes bigint not null check (ingress_bytes >= 0),
  timing_sample_count bigint not null check (timing_sample_count >= 0),
  latency_histogram bigint[] not null default '{}' check (coalesce(array_length(latency_histogram, 1), 0) <= 32 and 0 <= all(latency_histogram)),
  primary key (device_id, bucket_at)
);

create table public.incidents (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique check (reference ~ '^INC-[1-9][0-9]{0,8}$'),
  fingerprint text not null check (length(fingerprint) between 1 and 160),
  error_code text not null check (error_code in ('CONNECTION_TIMEOUT', 'MIC_PERMISSION_DENIED', 'PROVIDER_UNAVAILABLE', 'AUDIO_STARTUP_TIMEOUT', 'POLICY_SYNC_FAILED')),
  component text not null check (component in ('android', 'control', 'provider', 'network')),
  severity text not null check (severity in ('critical', 'high', 'medium')),
  build text not null check (build ~ '^[0-9]{1,4}(\.[0-9]{1,4}){0,3}$'),
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  occurrences bigint not null check (occurrences > 0),
  status text not null default 'open' check (status in ('open', 'triaged', 'repair_requested', 'resolved')),
  fix_class text not null check (fix_class in ('code_candidate', 'configuration', 'external', 'hotel_action')),
  owner_id uuid references public.admin_members(user_id),
  due_at timestamptz not null,
  resolved_at timestamptz,
  check (last_seen_at >= first_seen_at)
);
create index incidents_fingerprint_idx on public.incidents(fingerprint, last_seen_at);
create table public.incident_devices (
  incident_id uuid not null references public.incidents(id) on delete cascade,
  device_id uuid not null references public.devices(id),
  primary key (incident_id, device_id)
);

create table public.repair_requests (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references public.incidents(id),
  requested_by uuid not null references public.admin_members(user_id),
  target text not null check (target in ('android_handoff', 'new_admin_repo', 'manual_runbook')),
  state text not null default 'brief_ready' check (state = 'brief_ready'),
  created_at timestamptz not null default now()
);

create table public.admin_audit (
  id bigint generated always as identity primary key,
  actor_id uuid not null references public.admin_members(user_id),
  device_id uuid references public.devices(id),
  incident_id uuid references public.incidents(id),
  action text not null check (action in ('policy_requested', 'credential_revoked', 'repair_prepared', 'incident_triaged')),
  policy_revision bigint check (policy_revision > 0),
  desired_access text check (desired_access in ('pending', 'approved', 'blocked')),
  reason text not null check (length(reason) between 1 and 240),
  created_at timestamptz not null default now()
);

-- Explicit grants + RLS. Membership and all business mutations remain server-owned.
-- Service-role authorization is application responsibility; service_role bypasses RLS.
do $$
declare table_name text;
begin
  foreach table_name in array array[
    'admin_members', 'hotels', 'devices', 'voice_sessions', 'session_attempts',
    'technical_events', 'traffic_buckets', 'incidents', 'incident_devices',
    'repair_requests', 'admin_audit'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on table public.%I from public, anon, authenticated', table_name);
    execute format('grant select on table public.%I to authenticated', table_name);
    execute format('grant all on table public.%I to service_role', table_name);
    execute format('create policy enabled_admin_read on public.%I for select to authenticated using ((select private.is_enabled_admin()))', table_name);
  end loop;
end $$;

alter table private.device_credentials enable row level security;
alter table private.provider_calls enable row level security;
revoke all on table private.device_credentials, private.provider_calls from public, anon, authenticated;
grant all on table private.device_credentials, private.provider_calls to service_role;
grant usage, select on sequence public.admin_audit_id_seq to service_role;

-- No device or authenticated-client INSERT/UPDATE/DELETE policy is installed.
-- Future trusted API transactions must authorize, dedupe, finalize monotonically,
-- update heartbeat only from fresh heartbeats, and append audit atomically.
commit;
