-- 0008 rev1: derive incidents from connection.failed technical events (contract REV 11/§5).
-- Bounded mapping (never trusts event content beyond server-mapped enums). Replay-safe: the
-- events PK (device_id, event_id) already dedupes, so a replayed event never re-derives.
-- Idempotent: occurrences are per-fingerprint counters, not row duplications.
-- INC reference source: baseline never defined one (no producer existed); this sequence is it.
create sequence if not exists public.incident_reference_seq as bigint start with 1;

-- Upgrade heal (QA upgrade finding): databases that already suffered the pre-index race carry
-- duplicate ACTIVE incidents per fingerprint, and the unique index below would fail to build.
-- Merge each duplicate set transactionally BEFORE creating the index:
--   survivor = earliest first_seen_at (tie: smallest reference);
--   occurrences summed, first_seen_at = min, last_seen_at = max, due_at = min, severity = highest;
--   device links unioned (deduped), repair_requests and admin_audit repointed (history kept);
--   alert notifications: per recipient keep the most advanced state (pending<sent<delivered<
--   bounced/failed; tie: earliest created) so a delivered/sent terminal state is never lost and
--   at most one claimable pending row per recipient survives.
do $$
declare
  r record;
  v_keep uuid;
begin
  for r in
    select fingerprint from public.incidents
     where status <> 'resolved'
     group by fingerprint having count(*) > 1
  loop
    select i.id into v_keep from public.incidents i
     where i.status <> 'resolved' and i.fingerprint = r.fingerprint
     order by i.first_seen_at asc, i.reference asc
     limit 1;

    -- drop losing alert rows across the whole duplicate set (before repointing, so the
    -- (incident_id, recipient) unique constraint cannot collide)
    delete from public.alert_notifications a
     using public.incidents i
     where a.incident_id = i.id and i.fingerprint = r.fingerprint
       and exists (
         select 1 from public.alert_notifications b
          join public.incidents ib on ib.id = b.incident_id
         where ib.fingerprint = r.fingerprint
           and b.recipient = a.recipient
           and (b.id <> a.id)
           and (case b.state when 'pending' then 0 when 'sent' then 1 when 'delivered' then 2 else 3 end
                  > case a.state when 'pending' then 0 when 'sent' then 1 when 'delivered' then 2 else 3 end
             or (case b.state when 'pending' then 0 when 'sent' then 1 when 'delivered' then 2 else 3 end
                   = case a.state when 'pending' then 0 when 'sent' then 1 when 'delivered' then 2 else 3 end
                 and (b.created_at, b.id) < (a.created_at, a.id))));

    update public.alert_notifications a set incident_id = v_keep
      from public.incidents i
     where a.incident_id = i.id and i.fingerprint = r.fingerprint and i.id <> v_keep;

    update public.repair_requests q set incident_id = v_keep
      from public.incidents i
     where q.incident_id = i.id and i.fingerprint = r.fingerprint and i.id <> v_keep;

    update public.admin_audit q set incident_id = v_keep
      from public.incidents i
     where q.incident_id = i.id and i.fingerprint = r.fingerprint and i.id <> v_keep;

    insert into public.incident_devices (incident_id, device_id)
      select distinct v_keep, d.device_id
        from public.incident_devices d
        join public.incidents i on i.id = d.incident_id
       where i.fingerprint = r.fingerprint and i.id <> v_keep
      on conflict do nothing;

    update public.incidents k set
        occurrences = s.occ, first_seen_at = s.fs, last_seen_at = s.ls,
        due_at = s.due, severity = s.sev
      from (select sum(occurrences) as occ, min(first_seen_at) as fs, max(last_seen_at) as ls,
                   min(due_at) as due,
                   (array_agg(severity order by case severity when 'critical' then 0
                                                    when 'high' then 1 else 2 end))[1] as sev
              from public.incidents
             where status <> 'resolved' and fingerprint = r.fingerprint) s
     where k.id = v_keep;

    delete from public.incidents i
     where i.status <> 'resolved' and i.fingerprint = r.fingerprint and i.id <> v_keep;
  end loop;
end $$;

-- Active-incident predicate source of truth: status <> 'resolved'. The only writer of
-- resolved_at (triage resolve RPC, 0006) flips status in the same statement, so the partial
-- unique index below always matches the visible lifecycle; no separate resolved_at timing claim.
--
-- One ACTIVE incident per fingerprint, DB-enforced (QA race finding): concurrent first-occurrence
-- ingests serialize on this index instead of creating duplicate incidents that later abort the
-- trigger's UPDATE...RETURNING with more-than-one-row and destroy whole event batches.
create unique index if not exists incidents_active_fingerprint_key
  on public.incidents (fingerprint) where status <> 'resolved';
create or replace function public._derive_incident_from_event() returns trigger language plpgsql as $$
declare
  v_component text;
  v_severity  text;
  v_fix_class text;
  v_fingerprint text;
  v_build     text;
  v_id        uuid;
  v_try       int;
begin
  if new.kind <> 'connection.failed' then return new; end if;
  -- bounded server-side mappings only; unknown codes fall to conservative defaults
  v_component := case new.error_code
    when 'MIC_PERMISSION_DENIED' then 'android'
    when 'PROVIDER_UNAVAILABLE'  then 'provider'
    when 'CONNECTION_TIMEOUT'    then 'network'
    when 'AUDIO_STARTUP_TIMEOUT' then 'android'
    when 'POLICY_SYNC_FAILED'    then 'control'
    else 'network' end;
  v_severity := case new.error_code
    when 'POLICY_SYNC_FAILED' then 'critical'
    when 'CONNECTION_TIMEOUT' then 'medium'
    else 'high' end;
  v_fix_class := case new.error_code
    when 'MIC_PERMISSION_DENIED' then 'hotel_action'
    when 'PROVIDER_UNAVAILABLE'  then 'external'
    when 'CONNECTION_TIMEOUT'    then 'external'
    when 'AUDIO_STARTUP_TIMEOUT' then 'code_candidate'
    when 'POLICY_SYNC_FAILED'    then 'configuration'
    else 'external' end;
  v_build := new.build;
  v_fingerprint := coalesce(new.error_code,'UNSPECIFIED') || '|' || v_component || '|' || coalesce(v_build,'unknown');
  -- Atomic upsert on the active-fingerprint index (QA race finding): the same incident
  -- re-occurring bumps the counter; a concurrent first occurrence waits on the index and then
  -- takes the update path, so one fingerprint can never yield two active incidents. The
  -- reference value comes from the sequence; a backfilled INC-n colliding with it is NOT caught
  -- by the fingerprint conflict arbiter, so retry after resyncing past the highest existing
  -- reference (converges in one extra attempt regardless of backfill size).
  for v_try in 1..100 loop
    begin
      insert into public.incidents (reference, fingerprint, error_code, component, severity, build, fix_class, occurrences, first_seen_at, last_seen_at, due_at)
      values ('INC-' || nextval('public.incident_reference_seq'), v_fingerprint, new.error_code, v_component, v_severity, v_build, v_fix_class, 1, new.occurred_at, new.occurred_at,
              new.occurred_at + (case when v_severity = 'critical' then interval '60 minutes' else interval '240 minutes' end))
      on conflict (fingerprint) where status <> 'resolved' do update
         set occurrences = public.incidents.occurrences + 1, last_seen_at = excluded.last_seen_at
      returning id into v_id;
      exit;
    exception when unique_violation then
      perform setval('public.incident_reference_seq',
                     coalesce((select max(substring(i.reference from 5)::bigint) from public.incidents i), 1));
      v_id := null;
    end;
  end loop;
  if v_id is null then
    raise exception 'MNZ:UNAVAILABLE: could not allocate an incident reference';
  end if;
  -- link device<->incident, no duplicates on retry
  insert into public.incident_devices (incident_id, device_id)
    select v_id, new.device_id where not exists (
      select 1 from public.incident_devices where incident_id = v_id and device_id = new.device_id);
  return new;
end $$;

drop trigger if exists technical_events_derive_incident on public.technical_events;
create trigger technical_events_derive_incident
  after insert on public.technical_events
  for each row execute function public._derive_incident_from_event();
