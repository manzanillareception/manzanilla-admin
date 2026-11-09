-- Control-plane RPCs (backend migration request #2 remainder, contract v1).
-- Every function is security definer, public-schema (PostgREST-reachable), granted to
-- service_role ONLY. The route layer authenticates (admin session / hotel session / device
-- credential) before calling; these functions are the transactional core. Application errors
-- raise as 'MNZ:<CODE>:<message>' and are mapped by the store to contract section-8 codes.
begin;

-- Shared guard: actor must be an ENABLED internal admin (route already checked; defense in depth).
create or replace function private.require_enabled_admin(p_actor uuid)
returns void language plpgsql stable security definer set search_path = ''
as $$
begin
  if not exists (select 1 from public.admin_members m where m.user_id = p_actor and m.enabled) then
    raise exception 'MNZ:FORBIDDEN: not an enabled internal admin';
  end if;
end $$;
revoke all on function private.require_enabled_admin(uuid) from public, anon, authenticated;
grant execute on function private.require_enabled_admin(uuid) to service_role;

-- Device credential lookup: returns the device row plus credential_state, or no rows for an
-- unknown hash. Revoked credentials still return their row so the route can answer
-- CREDENTIAL_REVOKED instead of UNAUTHORIZED.
create or replace function public.credential_device_lookup(p_token_hash text)
returns table (id uuid, hotel_id uuid, code text, label text, build text, managed boolean,
               credential_state text, desired_access text, effective_access text,
               policy_revision bigint, ack_revision bigint, last_seen_at timestamptz,
               last_boot_id uuid, last_heartbeat_sequence int, mode text, microphone text)
language sql stable security definer set search_path = ''
as $$
  select d.id, d.hotel_id, d.code, d.label, d.build, d.managed,
         case when c.revoked_at is null then 'valid' else 'revoked' end,
         d.desired_access, d.effective_access, d.policy_revision, d.ack_revision,
         d.last_seen_at, d.last_boot_id, d.last_heartbeat_sequence, d.mode, d.microphone
  from private.device_credentials c
  join public.devices d on d.id = c.device_id
  where c.token_hash = p_token_hash;
$$;
revoke all on function public.credential_device_lookup(text) from public, anon, authenticated;
grant execute on function public.credential_device_lookup(text) to service_role;

-- Enrollment (contract rev6): exactly one credential path. Token path consumes the one-use
-- setup token atomically; hotel path trusts the route-resolved hotel session scope.
-- Code uniqueness violations surface as 23505 (store maps to CONFLICT; route retries).
create or replace function public.control_enroll_device(
  p_token_hash text, p_hotel_id uuid, p_credential_hash text,
  p_code text, p_label text, p_build text)
returns table (device_id uuid, hotel_id uuid, policy_revision bigint)
language plpgsql security definer set search_path = ''
as $$
declare
  v_hotel uuid;
  v_device uuid;
begin
  if (p_token_hash is null) = (p_hotel_id is null) then
    raise exception 'MNZ:VALIDATION_FAILED: exactly one enrollment credential path is required';
  end if;
  if p_token_hash is not null then
    select t.hotel_id into v_hotel from private.device_setup_tokens t where t.token_hash = p_token_hash;
    if v_hotel is null then
      raise exception 'MNZ:SETUP_TOKEN_INVALID: unknown setup token';
    end if;
    -- Atomic consumption: fails for consumed or expired tokens.
    update private.device_setup_tokens t set consumed_at = now()
     where t.token_hash = p_token_hash and t.consumed_at is null and t.expires_at > now();
    if not found then
      if exists (select 1 from private.device_setup_tokens t where t.token_hash = p_token_hash and t.consumed_at is not null) then
        raise exception 'MNZ:SETUP_TOKEN_CONSUMED: setup token already used';
      end if;
      raise exception 'MNZ:SETUP_TOKEN_INVALID: setup token expired';
    end if;
  else
    if not exists (select 1 from public.hotels h where h.id = p_hotel_id) then
      raise exception 'MNZ:VALIDATION_FAILED: unknown hotel';
    end if;
    v_hotel := p_hotel_id;
  end if;

  -- Enrolled control-plane devices are managed (backend finding F-managed).
  insert into public.devices (hotel_id, code, label, build, managed)
  values (v_hotel, p_code, p_label, p_build, true)
  returning id into v_device;
  insert into private.device_credentials (device_id, token_hash) values (v_device, p_credential_hash);
  if p_token_hash is not null then
    update private.device_setup_tokens t set consumed_by_device = v_device where t.token_hash = p_token_hash;
  end if;
  return query select v_device, v_hotel, 1::bigint;
end $$;
revoke all on function public.control_enroll_device(text, uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.control_enroll_device(text, uuid, text, text, text, text) to service_role;

-- Boot generations (main's replay flag): a changed bootId alone cannot prove a new boot -
-- an old generation returning later must not refresh presence. Every seen bootId is recorded
-- in private.device_boots; only a NEVER-SEEN bootId starts a new generation. A bootId that
-- is neither current nor new is a replay: applied=false, no presence change.
create table private.device_boots (
  device_id uuid not null references public.devices(id) on delete cascade,
  boot_id uuid not null,
  first_seen_at timestamptz not null default now(),
  primary key (device_id, boot_id)
);
revoke all on private.device_boots from public, anon, authenticated;
grant select, insert on private.device_boots to service_role;

-- Heartbeat (contract section 3): (bootId, sequence) must strictly advance to be applied.
-- A never-seen bootId is a new boot generation (sequence may restart). Replays return the current
-- row with applied=false and never move presence. Presence time is the server receipt time.
create or replace function public.control_record_heartbeat(
  p_device_id uuid, p_boot_id uuid, p_sequence int, p_build text,
  p_mode text, p_microphone text, p_received_at timestamptz)
returns table (applied boolean, id uuid, hotel_id uuid, code text, label text, build text,
               managed boolean, desired_access text, effective_access text,
               policy_revision bigint, ack_revision bigint, last_seen_at timestamptz,
               last_boot_id uuid, last_heartbeat_sequence int, mode text, microphone text)
language plpgsql security definer set search_path = ''
as $$
declare
  d public.devices%rowtype;
  v_applied boolean;
  v_new_generation boolean;
  v_registered_boot uuid;
begin
  select * into d from public.devices where devices.id = p_device_id for update;
  if d.id is null then
    raise exception 'MNZ:NOT_FOUND: unknown device';
  end if;
  -- The device row lock serializes heartbeats per device. Register the generation:
  -- insert succeeds only for a never-seen bootId (genuine new boot); a conflict with a
  -- non-current bootId is a replay and never refreshes presence.
  v_new_generation := false;
  insert into private.device_boots (device_id, boot_id) values (p_device_id, p_boot_id)
  on conflict do nothing
  returning boot_id into v_registered_boot;
  if v_registered_boot is not null and d.last_boot_id is distinct from p_boot_id then
    v_new_generation := true;
  end if;
  v_applied := v_new_generation
    or (d.last_boot_id = p_boot_id and p_sequence > coalesce(d.last_heartbeat_sequence, -1));
  if v_applied then
    update public.devices
       set last_seen_at = p_received_at, last_boot_id = p_boot_id,
           last_heartbeat_sequence = p_sequence, build = p_build, mode = p_mode,
           microphone = p_microphone
     where devices.id = p_device_id
    returning * into d;
  end if;
  return query select v_applied, d.id, d.hotel_id, d.code, d.label, d.build, d.managed,
    d.desired_access, d.effective_access, d.policy_revision, d.ack_revision,
    d.last_seen_at, d.last_boot_id, d.last_heartbeat_sequence, d.mode, d.microphone;
end $$;
revoke all on function public.control_record_heartbeat(uuid, uuid, int, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.control_record_heartbeat(uuid, uuid, int, text, text, text, timestamptz) to service_role;

-- Monotonic policy ACK: a stale ACK never regresses ack_revision. Effective access follows
-- desired only when the device ACKs the CURRENT revision. Returns the full device row.
create or replace function public.control_ack_policy(p_device_id uuid, p_revision bigint)
returns table (id uuid, hotel_id uuid, code text, label text, build text, managed boolean,
               desired_access text, effective_access text, policy_revision bigint,
               ack_revision bigint, last_seen_at timestamptz, last_boot_id uuid,
               last_heartbeat_sequence int, mode text, microphone text)
language plpgsql security definer set search_path = ''
as $$
declare
  d public.devices%rowtype;
begin
  select * into d from public.devices where devices.id = p_device_id for update;
  if d.id is null then
    raise exception 'MNZ:NOT_FOUND: unknown device';
  end if;
  -- An ACK for a revision never issued is corrupt state, not a stale ACK (backend finding
  -- F-future-ack): surface it instead of silently ignoring.
  if p_revision > d.policy_revision then
    raise exception 'MNZ:FUTURE_REVISION: ACK revision % exceeds issued policy revision %', p_revision, d.policy_revision;
  end if;
  if p_revision > d.ack_revision and p_revision <= d.policy_revision then
    update public.devices
       set ack_revision = p_revision,
           acknowledged_at = now(),
           effective_access = case when p_revision = d.policy_revision then d.desired_access else d.effective_access end
     where devices.id = p_device_id
    returning * into d;
  end if;
  return query select d.id, d.hotel_id, d.code, d.label, d.build, d.managed,
    d.desired_access, d.effective_access, d.policy_revision, d.ack_revision,
    d.last_seen_at, d.last_boot_id, d.last_heartbeat_sequence, d.mode, d.microphone;
end $$;
revoke all on function public.control_ack_policy(uuid, bigint) from public, anon, authenticated;
grant execute on function public.control_ack_policy(uuid, bigint) to service_role;

-- Event ingestion (contract sections 4-5): transactional (device_id, event_id) dedupe;
-- replays count as duplicates and are never re-applied. Session side effects are monotonic:
-- late events never reopen an ended session or move ended attempts. policy.ack events drive
-- the same monotonic ACK as control_ack_policy. Heartbeat state is never touched here.
create or replace function public.control_ingest_events(p_device_id uuid, p_received_at timestamptz, p_events jsonb)
returns table (accepted int, duplicates int)
language plpgsql security definer set search_path = ''
as $$
declare
  e jsonb;
  v_accepted int := 0;
  v_duplicates int := 0;
  v_session uuid;
  v_sess_feature text;
  v_sess_ended timestamptz;
  d public.devices%rowtype;
begin
  select * into d from public.devices where devices.id = p_device_id;
  if d.id is null then
    raise exception 'MNZ:NOT_FOUND: unknown device';
  end if;
  for e in select * from jsonb_array_elements(p_events) loop
    insert into public.technical_events (
      device_id, event_id, boot_id, sequence, occurred_at, received_at, kind, build,
      feature, session_reference, attempt_reference, error_code, duration_ms,
      duration_provenance, first_audio_ms, policy_revision, microphone, battery_percent, free_memory_mb)
    values (
      p_device_id, (e ->> 'eventId')::uuid, (e ->> 'bootId')::uuid, (e ->> 'sequence')::int,
      (e ->> 'occurredAt')::timestamptz, p_received_at, e ->> 'kind', e ->> 'build',
      e ->> 'feature', e ->> 'sessionId', e ->> 'attemptId', e ->> 'code',
      (e ->> 'durationMs')::bigint, e ->> 'durationProvenance', (e ->> 'firstAudioMs')::int,
      (e ->> 'revision')::bigint, e ->> 'microphone', (e ->> 'batteryPercent')::int, (e ->> 'freeMemoryMb')::int)
    on conflict (device_id, event_id) do nothing;
    if not found then
      v_duplicates := v_duplicates + 1;
      continue;
    end if;
    v_accepted := v_accepted + 1;

    case e ->> 'kind'
    when 'session.started' then
      insert into public.voice_sessions (device_id, feature, state, started_at, policy_revision, client_session_ref)
      values (p_device_id, e ->> 'feature', 'creating', (e ->> 'occurredAt')::timestamptz,
              d.policy_revision, e ->> 'sessionId')
      on conflict do nothing;
      select s.id, s.feature, s.ended_at into v_session, v_sess_feature, v_sess_ended from public.voice_sessions s
        where s.device_id = p_device_id and s.client_session_ref = e ->> 'sessionId';
      -- Contract section 4: one sessionId never changes feature (backend finding F-feature-flip).
      -- A conflicting event aborts the batch atomically so the device resyncs.
      if v_session is not null and v_sess_feature is distinct from (e ->> 'feature') then
        raise exception 'MNZ:SESSION_FEATURE_MISMATCH: session % is %, event claims %',
          e ->> 'sessionId', v_sess_feature, e ->> 'feature';
      end if;
      -- An ended session never gains a new attempt (same rule as admission).
      if v_session is not null and v_sess_ended is not null then
        raise exception 'MNZ:INVALID_STATE: session % already ended', e ->> 'sessionId';
      end if;
      if v_session is not null then
        insert into public.session_attempts (session_id, device_id, attempt_number, started_at, outcome, client_attempt_ref)
        select v_session, p_device_id,
               coalesce((select max(a.attempt_number) from public.session_attempts a where a.session_id = v_session), 0) + 1,
               (e ->> 'occurredAt')::timestamptz, 'active', e ->> 'attemptId'
        on conflict do nothing;
      end if;
    when 'session.connected' then
      update public.voice_sessions s
         set state = 'connected', connected_at = (e ->> 'occurredAt')::timestamptz
       where s.device_id = p_device_id and s.client_session_ref = e ->> 'sessionId'
         and s.ended_at is null;
      update public.session_attempts a
         set connected_at = (e ->> 'occurredAt')::timestamptz,
             first_audio_ms = coalesce((e ->> 'firstAudioMs')::int, a.first_audio_ms)
       where a.device_id = p_device_id and a.client_attempt_ref = e ->> 'attemptId'
         and a.ended_at is null;
    when 'session.ended' then
      update public.voice_sessions s
         set state = 'ended', ended_at = (e ->> 'occurredAt')::timestamptz,
             duration_ms = (e ->> 'durationMs')::bigint,
             duration_provenance = coalesce(e ->> 'durationProvenance', 'unknown')
       where s.device_id = p_device_id and s.client_session_ref = e ->> 'sessionId'
         and s.ended_at is null;
      update public.session_attempts a
         set ended_at = (e ->> 'occurredAt')::timestamptz, outcome = 'completed'
       where a.device_id = p_device_id and a.client_attempt_ref = e ->> 'attemptId'
         and a.ended_at is null;
    when 'connection.failed' then
      update public.session_attempts a
         set ended_at = (e ->> 'occurredAt')::timestamptz, outcome = 'failed', failure_code = e ->> 'code'
       where a.device_id = p_device_id and a.client_attempt_ref = e ->> 'attemptId'
         and a.ended_at is null;
    when 'policy.ack' then
      perform public.control_ack_policy(p_device_id, (e ->> 'revision')::bigint);
    else
      null; -- diagnostic.snapshot: stored only
    end case;
  end loop;
  return query select v_accepted, v_duplicates;
end $$;
revoke all on function public.control_ingest_events(uuid, timestamptz, jsonb) from public, anon, authenticated;
grant execute on function public.control_ingest_events(uuid, timestamptz, jsonb) to service_role;

-- Session admission (contract section 3, revised by backend findings): policy gate only in
-- v1; provider field reserved. The gate is desired_access, NOT effective_access: an admin
-- block denies NEW sessions immediately at the server, without waiting for the device ACK
-- (F-admit-gate). Idempotent on (device, sessionRef, attemptRef): a repeat attemptRef
-- returns the recorded decision; a NEW attemptRef on an existing sessionRef records the new
-- attempt (F-admit-attempt). A session's feature never changes (F-feature-flip).
-- No capacity model in v1 (reserved).
create or replace function public.control_admit_session(
  p_device_id uuid, p_session_ref text, p_attempt_ref text, p_feature text)
returns table (admit boolean, reason text, policy_revision bigint)
language plpgsql security definer set search_path = ''
as $$
declare
  d public.devices%rowtype;
  v_session uuid;
  v_sess_feature text;
  v_sess_ended timestamptz;
begin
  select * into d from public.devices where devices.id = p_device_id for update;
  if d.id is null then
    raise exception 'MNZ:NOT_FOUND: unknown device';
  end if;
  if d.desired_access <> 'approved' then
    return query select false, d.desired_access, d.policy_revision;
    return;
  end if;
  select s.id, s.feature, s.ended_at into v_session, v_sess_feature, v_sess_ended
   from public.voice_sessions s
   where s.device_id = p_device_id and s.client_session_ref = p_session_ref;
  if v_session is not null then
    -- An ended session never gains attempts (backend regression: ended-session new attempt).
    if v_sess_ended is not null then
      raise exception 'MNZ:INVALID_STATE: session % already ended', p_session_ref;
    end if;
    if v_sess_feature <> p_feature then
      raise exception 'MNZ:SESSION_FEATURE_MISMATCH: session % is %, admission claims %',
        p_session_ref, v_sess_feature, p_feature;
    end if;
    -- Existing session: record the new attempt (no-op when this attemptRef is already recorded).
    insert into public.session_attempts (session_id, device_id, attempt_number, started_at, outcome, client_attempt_ref)
    select v_session, p_device_id,
           coalesce((select max(a.attempt_number) from public.session_attempts a where a.session_id = v_session), 0) + 1,
           now(), 'active', p_attempt_ref
    on conflict do nothing;
    return query select true, null::text, d.policy_revision;
    return;
  end if;
  insert into public.voice_sessions (device_id, feature, state, started_at, policy_revision, client_session_ref)
  values (p_device_id, p_feature, 'creating', now(), d.policy_revision, p_session_ref)
  returning voice_sessions.id into v_session;
  insert into public.session_attempts (session_id, device_id, attempt_number, started_at, outcome, client_attempt_ref)
  select v_session, p_device_id,
         coalesce((select max(a.attempt_number) from public.session_attempts a where a.session_id = v_session), 0) + 1,
         now(), 'active', p_attempt_ref
  on conflict do nothing;
  return query select true, null::text, d.policy_revision;
end $$;
revoke all on function public.control_admit_session(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.control_admit_session(uuid, text, text, text) to service_role;

-- Admin policy change (contract section 3): optimistic revision check, atomic revision bump
-- plus immutable admin_audit row. Effective access moves only on the device ACK.
create or replace function public.control_set_device_policy(
  p_actor uuid, p_device_id uuid, p_expected_revision bigint, p_desired text, p_reason text)
returns table (device_id uuid, policy_revision bigint, desired_access text, effective_access text, recorded boolean)
language plpgsql security definer set search_path = ''
as $$
declare
  d public.devices%rowtype;
  v_revision bigint;
begin
  perform private.require_enabled_admin(p_actor);
  select * into d from public.devices where devices.id = p_device_id for update;
  if d.id is null then
    raise exception 'MNZ:NOT_FOUND: unknown device';
  end if;
  -- Idempotent repeat (contract section 3, backend finding F-idempotent-policy): an identical
  -- request (same expected revision AND same desired state) is a no-op - no revision advance,
  -- no second audit row. Checked BEFORE the staleness guard.
  if d.policy_revision = p_expected_revision and d.desired_access = p_desired then
    device_id := d.id;
    policy_revision := d.policy_revision;
    desired_access := d.desired_access;
    effective_access := d.effective_access;
    recorded := false; -- current state, not a historical result
    return next;
    return; -- stop: return next alone continues into the staleness guard
  end if;
  -- True retry of THIS ACTOR's own recorded operation (contract rev10/rev11): the audit row
  -- for (actor, device, revision expected+1, same desired, SAME REASON) returns the recorded
  -- result, not 409. A stale edit by another actor, a different desired state, or a DIFFERENT
  -- reason is not a retry and still fails - a new rationale is never silently dropped.
  if d.policy_revision > p_expected_revision
     and exists (select 1 from public.admin_audit a
                 where a.actor_id = p_actor and a.device_id = p_device_id
                   and a.action = 'policy_requested'
                   and a.policy_revision = p_expected_revision + 1
                   and a.desired_access = p_desired
                   and a.reason = p_reason) then
    device_id := d.id;
    policy_revision := p_expected_revision + 1; -- the recorded result of the retried operation
    desired_access := p_desired;
    effective_access := d.effective_access;
    recorded := true; -- explicit: historical result, NOT current state (contract rev11)
    return next;
    return;
  end if;
  if d.policy_revision <> p_expected_revision then
    raise exception 'MNZ:STALE_REVISION: expected %, current %', p_expected_revision, d.policy_revision;
  end if;
  v_revision := d.policy_revision + 1;
  update public.devices
     set policy_revision = v_revision, desired_access = p_desired, policy_changed_at = now()
   where devices.id = p_device_id
  returning devices.policy_revision, devices.desired_access, devices.effective_access
     into policy_revision, desired_access, effective_access;
  -- reason column holds the full bounded reason (500, since 0006 rev2); never truncated.
  insert into public.admin_audit (actor_id, device_id, action, policy_revision, desired_access, reason)
  values (p_actor, p_device_id, 'policy_requested', v_revision, p_desired, p_reason);
  device_id := p_device_id;
  recorded := false;
  return next;
end $$;
revoke all on function public.control_set_device_policy(uuid, uuid, bigint, text, text) from public, anon, authenticated;
grant execute on function public.control_set_device_policy(uuid, uuid, bigint, text, text) to service_role;

-- Repair brief request: server-owned briefs only; marks the incident repair_requested.
create or replace function public.control_request_repair(p_actor uuid, p_incident_id uuid, p_target text)
returns table (repair_request_id uuid)
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_status text;
begin
  perform private.require_enabled_admin(p_actor);
  -- Existence and state guards (backend finding F-repair): a missing incident must be
  -- MNZ:NOT_FOUND, not a raw 23503; a resolved incident accepts no new repair brief.
  select i.status into v_status from public.incidents i where i.id = p_incident_id;
  if v_status is null then
    raise exception 'MNZ:NOT_FOUND: unknown incident';
  end if;
  if v_status = 'resolved' then
    raise exception 'MNZ:INVALID_STATE: incident already resolved';
  end if;
  insert into public.repair_requests (incident_id, requested_by, target)
  values (p_incident_id, p_actor, p_target)
  returning id into v_id;
  update public.incidents set status = 'repair_requested'
   where incidents.id = p_incident_id and status in ('open', 'triaged');
  insert into public.admin_audit (actor_id, incident_id, action, reason)
  values (p_actor, p_incident_id, 'repair_prepared', 'repair brief prepared: ' || p_target);
  return query select v_id;
end $$;
revoke all on function public.control_request_repair(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.control_request_repair(uuid, uuid, text) to service_role;

-- Mint a one-use setup token (contract section 10): only the hash is stored; the plaintext
-- left the process in the route response exactly once.
create or replace function public.control_mint_setup_token(
  p_hotel_id uuid, p_token_hash text, p_expires_at timestamptz, p_created_by uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.require_enabled_admin(p_created_by);
  insert into private.device_setup_tokens (token_hash, hotel_id, expires_at, created_by)
  values (p_token_hash, p_hotel_id, p_expires_at, p_created_by);
end $$;
revoke all on function public.control_mint_setup_token(uuid, text, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.control_mint_setup_token(uuid, text, timestamptz, uuid) to service_role;

commit;
