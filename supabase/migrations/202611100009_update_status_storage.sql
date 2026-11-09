-- 0009 rev1: persist allowlisted update.status fields as TYPED columns (contract REV 12/13).
-- No generic payload jsonb: only the seven allowlisted update fields are stored, and only
-- for kind = 'update.status'; every other kind leaves them NULL. Dedupe/replay unaffected.
alter table public.technical_events
  add column update_feed_id text,
  add column update_state text check (update_state is null or update_state in
    ('up_to_date','update_available','downloading','downloaded','installing','installed','failed')),
  add column update_current_build text,
  add column update_discovered_version text,
  add column update_published_at timestamptz,
  add column update_progress_pct int check (update_progress_pct is null or update_progress_pct between 0 and 100),
  add column update_error text;

-- dashboard projection source (REV 13): latest accepted update.status per device.
create index technical_events_update_status_idx on public.technical_events (device_id, occurred_at desc, received_at desc)
  where kind = 'update.status';

CREATE OR REPLACE FUNCTION public.control_ingest_events(p_device_id uuid, p_received_at timestamp with time zone, p_events jsonb)
 RETURNS TABLE(accepted integer, duplicates integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
      duration_provenance, first_audio_ms, policy_revision, microphone, battery_percent, free_memory_mb,
      update_feed_id, update_state, update_current_build, update_discovered_version,
      update_published_at, update_progress_pct, update_error)
    values (
      p_device_id, (e ->> 'eventId')::uuid, (e ->> 'bootId')::uuid, (e ->> 'sequence')::int,
      (e ->> 'occurredAt')::timestamptz, p_received_at, e ->> 'kind', e ->> 'build',
      e ->> 'feature', e ->> 'sessionId', e ->> 'attemptId', e ->> 'code',
      (e ->> 'durationMs')::bigint, e ->> 'durationProvenance', (e ->> 'firstAudioMs')::int,
      (e ->> 'revision')::bigint, e ->> 'microphone', (e ->> 'batteryPercent')::int, (e ->> 'freeMemoryMb')::int,
      -- update.status (REV 13/0009): allowlisted fields only, null for every other kind
      case when e ->> 'kind' = 'update.status' then e ->> 'feedId' end,
      case when e ->> 'kind' = 'update.status' then e ->> 'state' end,
      case when e ->> 'kind' = 'update.status' then e ->> 'currentBuild' end,
      case when e ->> 'kind' = 'update.status' then e ->> 'discoveredVersion' end,
      case when e ->> 'kind' = 'update.status' then (e ->> 'publishedAt')::timestamptz end,
      case when e ->> 'kind' = 'update.status' then (e ->> 'progressPct')::int end,
      case when e ->> 'kind' = 'update.status' then left(e ->> 'error', 500) end)
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
end $function$

