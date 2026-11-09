-- Assertions after applying 0008 rev7 over upgrade-0008-fixture.sql.
do $$
declare
  v record;
  n int;
begin
  -- exactly one active incident remains for the fingerprint, fully merged
  select count(*) into n from public.incidents
   where status <> 'resolved' and fingerprint = 'MIC_PERMISSION_DENIED|android|9.9.9';
  if n <> 1 then raise exception 'dedupe: expected 1 active incident, got %', n; end if;

  select * into v from public.incidents
   where status <> 'resolved' and fingerprint = 'MIC_PERMISSION_DENIED|android|9.9.9';
  if v.id <> '00000000-0000-0000-0000-0000000000e1' then raise exception 'dedupe: wrong survivor %', v.id; end if;
  if v.occurrences <> 5 then raise exception 'dedupe: occurrences % != 5', v.occurrences; end if;
  if v.first_seen_at <> '2026-11-09 10:00:00+00' then raise exception 'dedupe: first_seen_at %', v.first_seen_at; end if;
  if v.last_seen_at <> '2026-11-09 12:00:00+00' then raise exception 'dedupe: last_seen_at %', v.last_seen_at; end if;
  if v.due_at <> '2026-11-09 13:00:00+00' then raise exception 'dedupe: due_at %', v.due_at; end if;
  if v.severity <> 'high' then raise exception 'dedupe: severity % != high', v.severity; end if;

  -- both devices linked to the survivor exactly once
  select count(*) into n from public.incident_devices where incident_id = v.id;
  if n <> 2 then raise exception 'dedupe: % device links != 2', n; end if;

  -- alerts: one row per recipient on the survivor; sent wins over pending; earliest pending wins
  select count(*) into n from public.alert_notifications where incident_id = v.id;
  if n <> 2 then raise exception 'dedupe: % alert rows != 2', n; end if;
  if not exists (select 1 from public.alert_notifications
                  where incident_id = v.id and recipient = 'r1@example.com' and state = 'pending'
                    and created_at = '2026-11-09 10:00:05+00')
    then raise exception 'dedupe: r1 pending (earliest) not preserved'; end if;
  if not exists (select 1 from public.alert_notifications
                  where incident_id = v.id and recipient = 'r2@example.com' and state = 'sent')
    then raise exception 'dedupe: r2 sent terminal state not preserved'; end if;

  -- repair request and audit history repointed, not lost
  if not exists (select 1 from public.repair_requests where incident_id = v.id)
    then raise exception 'dedupe: repair request lost'; end if;
  if not exists (select 1 from public.admin_audit where incident_id = v.id and action = 'incident_triaged')
    then raise exception 'dedupe: audit row lost'; end if;

  -- derivation keeps working on the merged incident: one more event bumps occurrences to 6
  insert into public.technical_events (device_id, event_id, boot_id, sequence, occurred_at, kind, build, error_code)
  values ('00000000-0000-0000-0000-0000000000d2', gen_random_uuid(), gen_random_uuid(), 1,
          '2026-11-09 12:30:00+00', 'connection.failed', '9.9.9', 'MIC_PERMISSION_DENIED');
  select occurrences into n from public.incidents where id = v.id;
  if n <> 6 then raise exception 'dedupe: post-merge ingest occurrences % != 6', n; end if;
  select count(*) into n from public.incidents
   where status <> 'resolved' and fingerprint = 'MIC_PERMISSION_DENIED|android|9.9.9';
  if n <> 1 then raise exception 'dedupe: post-merge ingest created another incident'; end if;

  raise notice 'upgrade 0008 dedupe tests passed';
end $$;
