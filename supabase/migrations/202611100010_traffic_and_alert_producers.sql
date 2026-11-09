-- 0010 rev1: monitoring producer chain completion (spec line 133: real ingested events drive
-- every counter; line 91/182: incident notifications, deduplicated, acknowledged separately).
-- Part A: traffic_buckets derivation inside control_ingest_events (below, full replacement).
-- Part B: alert pending-row creation for NEW critical/high incidents (dedupe via the
-- baseline unique(incident_id, recipient)); sending stays a separate gated worker.
-- Not security definer (least privilege, F-0010b): the trigger runs with the caller's rights;
-- the only caller is the service_role-only ingest RPC, matching 0008's plain trigger function.
create or replace function public._alert_on_new_incident() returns trigger language plpgsql set search_path = '' as $$
begin
  -- Main ruling 2026-11-10: ALL severities alert (spec lines 91/133: incident notifications,
  -- one deduplicated alert per incident); no severity filter. Recurrence on the same
  -- fingerprint bumps the existing incident's counter and sends nothing new.
  insert into public.alert_notifications (incident_id, recipient)
    select new.id, u.email from public.admin_members m join auth.users u on u.id = m.user_id
    where m.enabled and u.email is not null
    on conflict (incident_id, recipient) do nothing;
  return new;
end $$;
revoke all on function public._alert_on_new_incident() from public, anon, authenticated;
drop trigger if exists incidents_alert_on_new on public.incidents;
create trigger incidents_alert_on_new
  after insert on public.incidents
  for each row execute function public._alert_on_new_incident();

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
      -- 0010: duplicate delivery is a retried request in the device's traffic bucket.
      insert into public.traffic_buckets (device_id, bucket_at, requests, failed_requests, retry_requests, ingress_bytes, timing_sample_count, latency_histogram)
      -- a retried request IS a request (baseline CHECK: retry_requests <= requests)
      values (p_device_id, date_trunc('hour', (e ->> 'occurredAt')::timestamptz), 1, 0, 1, octet_length(e::text), 0, '{}')
      on conflict (device_id, bucket_at) do update set
        retry_requests = public.traffic_buckets.retry_requests + 1,
        requests = public.traffic_buckets.requests + 1,
        ingress_bytes = public.traffic_buckets.ingress_bytes + octet_length(e::text);
      continue;
    end if;
    v_accepted := v_accepted + 1;
    -- 0010: accepted event feeds the hourly traffic bucket (bounded numeric aggregates only).
    insert into public.traffic_buckets (device_id, bucket_at, requests, failed_requests, retry_requests, ingress_bytes, timing_sample_count, latency_histogram)
    values (p_device_id, date_trunc('hour', (e ->> 'occurredAt')::timestamptz), 1,
            case when e ->> 'kind' = 'connection.failed' then 1 else 0 end, 0,
            octet_length(e::text),
            case when e ->> 'firstAudioMs' is not null then 1 else 0 end,
            case when e ->> 'firstAudioMs' is not null then
              (select array_agg(case when i = least(((e ->> 'firstAudioMs')::int / 250), 31) then 1 else 0 end) from generate_series(0, 31) i)
            else '{}' end)
    on conflict (device_id, bucket_at) do update set
      requests = public.traffic_buckets.requests + 1,
      failed_requests = public.traffic_buckets.failed_requests + case when e ->> 'kind' = 'connection.failed' then 1 else 0 end,
      ingress_bytes = public.traffic_buckets.ingress_bytes + octet_length(e::text),
      timing_sample_count = public.traffic_buckets.timing_sample_count + case when e ->> 'firstAudioMs' is not null then 1 else 0 end,
      latency_histogram = case when e ->> 'firstAudioMs' is not null then
        -- PG arrays are 1-based: 0-based bucket b lives at subscript b+1 (QA off-by-one finding).
        (select array_agg(coalesce(public.traffic_buckets.latency_histogram[i + 1], 0) + case when i = least(((e ->> 'firstAudioMs')::int / 250), 31) then 1 else 0 end) from generate_series(0, 31) i)
      else public.traffic_buckets.latency_histogram end;

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

