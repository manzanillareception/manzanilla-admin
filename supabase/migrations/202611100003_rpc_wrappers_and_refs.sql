-- Backend migration request #2: public service-role RPC wrappers + heartbeat freshness and
-- client session/attempt reference columns. Contract v1 (2026-11-10 rulings).
-- Rationale: Supabase does not expose the private schema via PostgREST by default, so
-- private.* RPCs are unreachable from supabase-js. These thin public wrappers are granted
-- to service_role ONLY; authorization remains the application layer's job (service_role
-- bypasses RLS). No anon/authenticated execute anywhere here.
begin;

create or replace function public.claim_provisioning_job(p_job_id uuid, p_worker text, p_lease_seconds int)
returns uuid language sql security definer set search_path = '' as $$
  select private.claim_provisioning_job(p_job_id, p_worker, p_lease_seconds);
$$;
revoke all on function public.claim_provisioning_job(uuid, text, int) from public, anon, authenticated;
grant execute on function public.claim_provisioning_job(uuid, text, int) to service_role;

create or replace function public.provisioning_stage_write(
  p_job_id uuid, p_worker text, p_status text,
  p_auth_user_id uuid default null, p_sealed_password text default null,
  p_set_sealed boolean default false, p_provider_message_id text default null,
  p_last_error text default null, p_clear_error boolean default false)
returns boolean language sql security definer set search_path = '' as $$
  select private.provisioning_stage_write(p_job_id, p_worker, p_status,
    p_auth_user_id, p_sealed_password, p_set_sealed, p_provider_message_id, p_last_error, p_clear_error);
$$;
revoke all on function public.provisioning_stage_write(uuid, text, text, uuid, text, boolean, text, text, boolean) from public, anon, authenticated;
grant execute on function public.provisioning_stage_write(uuid, text, text, uuid, text, boolean, text, text, boolean) to service_role;

create or replace function public.release_provisioning_job(p_job_id uuid, p_worker text)
returns boolean language sql security definer set search_path = '' as $$
  select private.release_provisioning_job(p_job_id, p_worker);
$$;
revoke all on function public.release_provisioning_job(uuid, text) from public, anon, authenticated;
grant execute on function public.release_provisioning_job(uuid, text) to service_role;

create or replace function public.requeue_provisioning_job(p_job_id uuid)
returns boolean language sql security definer set search_path = '' as $$
  select private.requeue_provisioning_job(p_job_id);
$$;
revoke all on function public.requeue_provisioning_job(uuid) from public, anon, authenticated;
grant execute on function public.requeue_provisioning_job(uuid) to service_role;

create or replace function public.advance_email_delivery(p_id text, p_state text, p_event_at timestamptz)
returns text language sql security definer set search_path = '' as $$
  select private.advance_email_delivery(p_id, p_state, p_event_at);
$$;
revoke all on function public.advance_email_delivery(text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.advance_email_delivery(text, text, timestamptz) to service_role;

create or replace function public.advance_alert_notification(p_id uuid, p_state text)
returns text language sql security definer set search_path = '' as $$
  select private.advance_alert_notification(p_id, p_state);
$$;
revoke all on function public.advance_alert_notification(uuid, text) from public, anon, authenticated;
grant execute on function public.advance_alert_notification(uuid, text) to service_role;

create or replace function public.consume_setup_token(p_token_hash text, p_device_id uuid)
returns uuid language sql security definer set search_path = '' as $$
  select private.consume_setup_token(p_token_hash, p_device_id);
$$;
revoke all on function public.consume_setup_token(text, uuid) from public, anon, authenticated;
grant execute on function public.consume_setup_token(text, uuid) to service_role;

-- Heartbeat freshness (contract section 3): server tracks the last accepted (bootId, sequence)
-- per device; replays return 200 but never move these columns or last_seen_at.
alter table public.devices
  add column last_boot_id uuid,
  add column last_heartbeat_sequence int check (last_heartbeat_sequence between 0 and 2147483647);

-- Client-supplied idempotency refs for session reservation (contract section 3:
-- repeated POST /devices/sessions on the same (deviceId, sessionId, attemptId) returns
-- the recorded decision). Bounds mirror the telemetry identifier rule.
alter table public.voice_sessions
  add column client_session_ref text check (client_session_ref ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$');
create unique index voice_sessions_client_ref on public.voice_sessions(device_id, client_session_ref)
  where client_session_ref is not null;

alter table public.session_attempts
  add column client_attempt_ref text check (client_attempt_ref ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$');
create unique index session_attempts_client_ref on public.session_attempts(device_id, client_attempt_ref)
  where client_attempt_ref is not null;

commit;
