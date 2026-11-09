-- Backend lane's INDEPENDENT verification of 0011 alert worker semantics (contract REV 14).
-- Complements the email lane's own db test. Self-contained; hard failures.
\set ON_ERROR_STOP on
begin;

-- Self-contained fixture: hotel + enrolled device + one enabled admin.
insert into public.hotels (id, name, city) values ('00000000-0000-0000-0000-0000000000c1', 'Verify Hotel', 'Seville');
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000c1', 'verify-hotel@test.invalid') on conflict do nothing;
insert into auth.users (id, email) values ('12121212-1212-4121-8121-121212121212', 'verify-admin@test.invalid') on conflict do nothing;
insert into public.admin_members (user_id, enabled) values ('12121212-1212-4121-8121-121212121212', true) on conflict do nothing;
select public.control_mint_setup_token(
  '00000000-0000-0000-0000-0000000000c1',
  'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  now() + interval '48 hours',
  '12121212-1212-4121-8121-121212121212');
create temp table v_dev as
  select * from public.control_enroll_device(
    'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', null,
    'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    'DEV-VERIFY01', 'Verify tablet', '17.0.44');

-- Producer coverage: a fresh incident must create one deduped alert row per enabled admin.
insert into public.incidents (reference, fingerprint, error_code, component, severity, build, fix_class, occurrences, first_seen_at, last_seen_at, due_at)
  values ('INC-902', 'VERIFY|control|17.0.44', 'POLICY_SYNC_FAILED', 'control', 'critical', '17.0.44', 'configuration', 1, now(), now(), now() + interval '1 hour');
do $$ begin
  assert (select count(*) from public.alert_notifications an join public.incidents i on i.id = an.incident_id
          where i.reference = 'INC-902' and an.recipient = 'verify-admin@test.invalid') = 1,
    'producer did not create exactly one alert row for the new critical incident';
end $$;

-- Public service_role wrapper smoke: claim + fenced success mark through the PostgREST path.
insert into public.alert_notifications (incident_id, recipient)
  select id, 'wrap@test.invalid' from public.incidents where reference = 'INC-902';
select id from public.alert_notifications where recipient = 'wrap@test.invalid' \gset
set local role service_role;
create temp table v_wrap_claim as select c from public.claim_alert_notifications('worker-wrap', 10, 120) c;
create temp table v_wrap_state as select public.mark_alert_attempt(:'id'::uuid, 'worker-wrap', true) as state;
reset role;
create temp table v_wrap as select :'id'::uuid as id;
do $$ begin
  assert (select count(*) from v_wrap_claim c join v_wrap w on w.id = c.c) = 1,
    'public claim wrapper did not return the row to service_role';
  assert (select state from v_wrap_state) = 'sent',
    'public mark wrapper did not advance to sent';
end $$;

-- Lease expiry: a zero-second lease is immediately reclaimable by another worker.
do $$
declare v_id uuid; v_first uuid; v_second uuid;
begin
  insert into public.alert_notifications (incident_id, recipient)
    select id, 'exp@test.invalid' from public.incidents where reference = 'INC-902' returning id into v_id;
  select c into v_first from private.claim_alert_notifications('worker-exp1', 10, 0) c where c = v_id;
  assert v_first = v_id, 'zero-lease claim failed';
  select c into v_second from private.claim_alert_notifications('worker-exp2', 10, 120) c where c = v_id;
  assert v_second = v_id, 'expired lease was not reclaimable';
  perform private.mark_alert_attempt(v_id, 'worker-exp2', true);
end $$;

-- 0008rev6 reference resync: on a reference collision the derivation resyncs the sequence past
-- the highest existing numeric reference and retries, converging in one extra attempt
-- regardless of backfill size. Expected derived reference = max(existing numeric) + 1.
do $$
declare v_next int; v_expected text; v_device uuid := (select device_id from v_dev);
begin
  select coalesce(last_value + 1, start_value) into v_next from pg_sequences where schemaname = 'public' and sequencename = 'incident_reference_seq';
  for i in 0..2 loop
    insert into public.incidents (reference, fingerprint, error_code, component, severity, build, fix_class, occurrences, first_seen_at, last_seen_at, due_at)
      values ('INC-' || (v_next + i), 'BACKFILL|' || i, 'CONNECTION_TIMEOUT', 'network', 'medium', '17.0.44', 'external', 1, now(), now(), now() + interval '4 hours');
  end loop;
  select 'INC-' || (max(substring(reference from 5)::int) + 1) into v_expected from public.incidents;
  insert into public.technical_events (device_id, event_id, boot_id, sequence, occurred_at, kind, build, error_code)
    values (v_device, 'abababab-abab-4bab-8bab-abababababab', '34343434-3434-4344-8434-343434343434',
            991, now(), 'connection.failed', '17.0.44', 'MIC_PERMISSION_DENIED');
  assert (select count(*) from public.incidents where error_code = 'MIC_PERMISSION_DENIED') = 1,
    'derivation failed over 3 backfilled references';
  assert (select reference from public.incidents where error_code = 'MIC_PERMISSION_DENIED') = v_expected,
    'derivation did not land on max+1 after resync (want ' || v_expected || ')';
end $$;

-- 150 pre-existing backfills: resync still converges (lead's claim); no MNZ:UNAVAILABLE path
-- is reachable via reference collisions because every collision resyncs past all of them.
do $$
declare v_next int; v_expected text; v_device uuid := (select device_id from v_dev);
begin
  select coalesce(last_value + 1, start_value) into v_next from pg_sequences where schemaname = 'public' and sequencename = 'incident_reference_seq';
  for i in 0..149 loop
    insert into public.incidents (reference, fingerprint, error_code, component, severity, build, fix_class, occurrences, first_seen_at, last_seen_at, due_at)
      values ('INC-' || (v_next + i), 'BACKFILL2|' || i, 'CONNECTION_TIMEOUT', 'network', 'medium', '17.0.44', 'external', 1, now(), now(), now() + interval '4 hours');
  end loop;
  select 'INC-' || (max(substring(reference from 5)::int) + 1) into v_expected from public.incidents;
  insert into public.technical_events (device_id, event_id, boot_id, sequence, occurred_at, kind, build, error_code)
    values (v_device, 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd', '34343434-3434-4344-8434-343434343434',
            992, now(), 'connection.failed', '17.0.44', 'AUDIO_STARTUP_TIMEOUT');
  assert (select count(*) from public.incidents where error_code = 'AUDIO_STARTUP_TIMEOUT') = 1,
    'derivation failed over 150 backfilled references';
  assert (select reference from public.incidents where error_code = 'AUDIO_STARTUP_TIMEOUT') = v_expected,
    'derivation did not land on max+1 after 150-backfill resync (want ' || v_expected || ')';
end $$;

-- Backoff schedule. REV 14 pins 1,2,4,8,16 minutes after failures 1..5; measure the FIRST
-- failure's delay. Kept last: this currently FAILS against 0011rev1 (power(2, attempts+1) = 2 min).
do $$
declare v_id uuid; v_delay interval;
begin
  insert into public.alert_notifications (incident_id, recipient)
    select id, 'backoff@test.invalid' from public.incidents where reference = 'INC-902' returning id into v_id;
  perform private.claim_alert_notifications('worker-bo', 1000, 120); -- must cover producer noise rows from the collision fixtures
  perform private.mark_alert_attempt(v_id, 'worker-bo', false);
  select next_attempt_at - now() into v_delay from public.alert_notifications where id = v_id;
  assert v_delay > interval '45 seconds' and v_delay < interval '75 seconds',
    'F-BACKOFF: first-failure delay is ' || v_delay || '; contract REV 14 pins 1 minute (1,2,4,8,16)';
end $$;

select 'alert worker independent verification passed' as result;
rollback;
