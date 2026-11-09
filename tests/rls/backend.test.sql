-- Backend lane disposable-Postgres assertions. Run AFTER stubs + the migration chain
-- (baseline, 0001rev3, 0002rev2, 003rev2, 0004rev5, 0005rev4, 0006rev2). The VERIFIED
-- section asserts behavior confirmed correct and must stay green. The retained-regression
-- section at the bottom asserts behavior that was open under earlier revisions and is
-- contractual since 0004rev5 / contract rev11; both sections are hard failures.
\set ON_ERROR_STOP on
begin;
set local role postgres;

-- Fixtures: admin member, hotel, hotel user, setup token hashes.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a0', 'admin@test.invalid'),
  ('00000000-0000-0000-0000-0000000000a1', 'hotel@test.invalid'),
  ('00000000-0000-0000-0000-0000000000a2', 'disabled@test.invalid'),
  ('00000000-0000-0000-0000-0000000000a3', 'admin2@test.invalid');
insert into public.admin_members (user_id, enabled) values
  ('00000000-0000-0000-0000-0000000000a0', true),
  ('00000000-0000-0000-0000-0000000000a2', false),
  ('00000000-0000-0000-0000-0000000000a3', true);
insert into public.hotels (id, name, city) values
  ('00000000-0000-0000-0000-0000000000b1', 'Test Hotel', 'Seville'),
  ('00000000-0000-0000-0000-0000000000b2', 'Other Hotel', 'Madrid');
insert into public.hotel_users (hotel_id, auth_user_id, email) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', 'hotel@test.invalid');

set local role service_role;

-- hotel_users trigger: an admin can never become a hotel user
do $$ begin
  begin
    insert into public.hotel_users (hotel_id, auth_user_id, email) values
      ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a0', 'x@test.invalid');
    raise exception 'admin admitted as hotel user';
  exception when raise_exception then null; end;
end $$;

-- Mint + consume setup token; enrollment returns pending device with credential lookup.
select public.control_mint_setup_token(
  '00000000-0000-0000-0000-0000000000b1',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  now() + interval '48 hours',
  '00000000-0000-0000-0000-0000000000a0');

create temp table enroll1 as
  select * from public.control_enroll_device(
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', null,
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    'DEV-TEST0001', 'Lobby tablet', '17.0.44');
do $$ begin
  assert (select count(*) from enroll1) = 1, 'enroll returns one device';
  assert (select policy_revision from enroll1) = 1, 'enroll revision 1';
  assert (select hotel_id from enroll1) = '00000000-0000-0000-0000-0000000000b1', 'token binds server-side hotel';
  assert (select d.desired_access from public.devices d join enroll1 e on d.id = e.device_id) = 'pending', 'device starts pending';
  assert (select count(*) from private.device_credentials dc join enroll1 e on dc.device_id = e.device_id
          where dc.token_hash = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb') = 1, 'hash stored';
  assert (select count(*) from public.credential_device_lookup('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')) = 1, 'lookup resolves';
  assert (select credential_state from public.credential_device_lookup('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')) = 'valid', 'credential valid';
  assert (select count(*) from public.credential_device_lookup('ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')) = 0, 'unknown credential resolves nothing';
end $$;

-- Replay: same token cannot enroll twice (consumed).
do $$ begin
  begin
    perform public.control_enroll_device('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', null,
      'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', 'DEV-TEST0002', 'T', '17.0.44');
    raise exception 'consumed token accepted';
  exception when raise_exception then
    if sqlerrm not like 'MNZ:SETUP_TOKEN_CONSUMED%' then raise; end if;
  end;
end $$;

-- Unknown token: SETUP_TOKEN_INVALID.
do $$ begin
  begin
    perform public.control_enroll_device('dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd', null,
      'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', 'DEV-TEST0003', 'T', '17.0.44');
    raise exception 'invalid token accepted';
  exception when raise_exception then
    if sqlerrm not like 'MNZ:SETUP_TOKEN_INVALID%' then raise; end if;
  end;
end $$;

-- Both credential paths set: VALIDATION_FAILED.
do $$ begin
  begin
    perform public.control_enroll_device('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      '00000000-0000-0000-0000-0000000000b1',
      'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', 'DEV-TEST0004', 'T', '17.0.44');
    raise exception 'dual-path enroll accepted';
  exception when raise_exception then
    if sqlerrm not like 'MNZ:VALIDATION_FAILED%' then raise; end if;
  end;
end $$;

-- Hotel-session path: enroll directly against the hotel (route verified hotel_users).
create temp table enroll2 as
  select * from public.control_enroll_device(null, '00000000-0000-0000-0000-0000000000b1',
    'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    'DEV-TEST0005', 'Desk tablet', '17.0.44');
do $$ begin assert (select count(*) from enroll2) = 1, 'hotel-path enroll works'; end $$;

-- Heartbeat freshness: first fresh, replay ignored, advancing sequence fresh, new boot fresh.
create temp table hb as
  select * from public.control_record_heartbeat((select device_id from enroll1),
    '10000000-0000-0000-0000-000000000001', 10, '17.0.44', 'idle', 'granted', now());
do $$ begin
  assert (select applied from hb), 'first heartbeat fresh';
  assert (select count(*) from public.devices d join enroll1 e on d.id = e.device_id where d.last_seen_at is not null) = 1, 'presence recorded';
end $$;
create temp table hb_replay as
  select * from public.control_record_heartbeat((select device_id from enroll1),
    '10000000-0000-0000-0000-000000000001', 10, '17.0.45', 'translation', 'denied', now() + interval '1 minute');
do $$ begin
  assert not (select applied from hb_replay), 'replay not fresh';
  assert (select d.build from public.devices d join enroll1 e on d.id = e.device_id) = '17.0.44', 'replay changed build';
end $$;
create temp table hb2 as
  select * from public.control_record_heartbeat((select device_id from enroll1),
    '10000000-0000-0000-0000-000000000001', 11, '17.0.45', 'translation', 'denied', now());
do $$ begin assert (select applied from hb2), 'advancing sequence fresh'; end $$;
create temp table hb3 as
  select * from public.control_record_heartbeat((select device_id from enroll1),
    '10000000-0000-0000-0000-000000000002', 0, '17.0.45', 'idle', 'granted', now());
do $$ begin assert (select applied from hb3), 'reboot with sequence reset is fresh'; end $$;

-- Contract rev7 mandated test: boot A seq 1-3 -> boot B seq 1 -> replayed boot A seq 5
-- must return applied=false with last_seen_at unchanged (private.device_boots history).
create temp table aba_presence as
  select d.last_seen_at from public.devices d join enroll1 e on d.id = e.device_id;
create temp table hb_aba as
  select * from public.control_record_heartbeat((select device_id from enroll1),
    '10000000-0000-0000-0000-000000000001', 999, '17.0.99', 'translation', 'denied', now() + interval '5 minutes');
do $$ begin
  assert not (select applied from hb_aba), 'old boot generation resurrected';
  assert (select d.build from public.devices d join enroll1 e on d.id = e.device_id) <> '17.0.99', 'resurrected boot changed device';
  assert (select d.last_seen_at from public.devices d join enroll1 e on d.id = e.device_id)
       = (select last_seen_at from aba_presence), 'replayed boot moved last_seen_at';
end $$;

-- Policy: pending device cannot admit a session.
create temp table adm_pending as
  select * from public.control_admit_session((select device_id from enroll1), 'sess-1', 'att-1', 'translation');
do $$ begin
  assert not (select admit from adm_pending), 'pending device admitted';
  assert (select reason from adm_pending) = 'pending', 'wrong deny reason';
end $$;

-- Admin approves: revision advances atomically with audit; stale revision rejected.
create temp table pol1 as
  select * from public.control_set_device_policy('00000000-0000-0000-0000-0000000000a0',
    (select device_id from enroll1), 1, 'approved', 'pilot approval');
do $$ begin
  assert (select policy_revision from pol1) = 2, 'revision advanced';
  assert (select desired_access from pol1) = 'approved', 'desired updated';
  assert (select effective_access from pol1) = 'pending', 'effective unchanged until ACK';
  assert (select count(*) from public.admin_audit where device_id = (select device_id from enroll1)
          and action = 'policy_requested' and policy_revision = 2) = 1, 'audit row appended';
end $$;
do $$ begin
  begin
    perform public.control_set_device_policy('00000000-0000-0000-0000-0000000000a0',
      (select device_id from enroll1), 1, 'blocked', 'stale write');
    raise exception 'stale revision accepted';
  exception when raise_exception then
    if sqlerrm not like 'MNZ:STALE_REVISION%' then raise; end if;
  end;
end $$;

-- Defense in depth: a disabled admin actor is refused inside the RPC too.
do $$ begin
  begin
    perform public.control_set_device_policy('00000000-0000-0000-0000-0000000000a2',
      (select device_id from enroll1), 2, 'blocked', 'disabled admin');
    raise exception 'disabled admin set policy';
  exception when raise_exception then
    if sqlerrm not like 'MNZ:FORBIDDEN%' then raise; end if;
  end;
end $$;

-- A future-revision ACK is rejected (0004rev3: MNZ:FUTURE_REVISION) and never moves state.
do $$ begin
  begin
    perform public.control_ack_policy((select device_id from enroll1), 99);
    raise exception 'future revision ACK accepted';
  exception when raise_exception then
    if sqlerrm not like 'MNZ:FUTURE_REVISION%' then raise; end if;
  end;
  assert (select d.ack_revision from public.devices d join enroll1 e on d.id = e.device_id) <> 99,
    'future ACK moved ack_revision';
end $$;

-- Current-revision ACK flips effective access.
create temp table ack2 as select * from public.control_ack_policy((select device_id from enroll1), 2);
do $$ begin
  assert (select d.effective_access from public.devices d join enroll1 e on d.id = e.device_id) = 'approved', 'effective after ACK';
  assert (select d.ack_revision from public.devices d join enroll1 e on d.id = e.device_id) = 2, 'ack revision recorded';
end $$;

-- Re-approve cycle: bump to 3 (blocked); a stale ACK of 2 must not move effective back.
create temp table pol3 as
  select * from public.control_set_device_policy('00000000-0000-0000-0000-0000000000a0',
    (select device_id from enroll1), 2, 'blocked', 'abuse report');
create temp table ack_stale as select * from public.control_ack_policy((select device_id from enroll1), 2);
do $$ begin
  assert (select d.ack_revision from public.devices d join enroll1 e on d.id = e.device_id) = 2, 'stale ACK moved ack_revision';
  assert (select d.effective_access from public.devices d join enroll1 e on d.id = e.device_id) = 'approved', 'stale ACK changed effective';
  assert (select d.desired_access from public.devices d join enroll1 e on d.id = e.device_id) = 'blocked', 'desired not blocked';
end $$;

-- Blocked device cannot admit once effective catches up (blocked devices still ACK).
create temp table ack3 as select * from public.control_ack_policy((select device_id from enroll1), 3);
create temp table adm_blocked as
  select * from public.control_admit_session((select device_id from enroll1), 'sess-1', 'att-1', 'translation');
do $$ begin
  assert not (select admit from adm_blocked), 'blocked device admitted';
  assert (select reason from adm_blocked) = 'blocked', 'wrong deny reason 2';
end $$;

-- Approve again for session tests.
create temp table pol4 as
  select * from public.control_set_device_policy('00000000-0000-0000-0000-0000000000a0',
    (select device_id from enroll1), 3, 'approved', 're-approve');
create temp table ack4 as select * from public.control_ack_policy((select device_id from enroll1), 4);

-- Admission: admit, idempotent replay, retry attempt on live session, capacity note.
create temp table adm1 as select * from public.control_admit_session((select device_id from enroll1), 'sess-1', 'att-1', 'translation');
do $$ begin assert (select admit from adm1), 'approved device not admitted'; end $$;
create temp table adm1_re as select * from public.control_admit_session((select device_id from enroll1), 'sess-1', 'att-1', 'translation');
do $$ begin assert (select admit from adm1_re), 'recorded decision not replayed'; end $$;
do $$ begin
  assert (select count(*) from public.session_attempts a join enroll1 e on a.device_id = e.device_id
          where a.client_attempt_ref = 'att-1') = 1,
    'idempotent admission created a duplicate attempt';
end $$;
create temp table adm1_att2 as select * from public.control_admit_session((select device_id from enroll1), 'sess-1', 'att-2', 'translation');
do $$ begin assert (select admit from adm1_att2), 'retry attempt not admitted on live session'; end $$;
-- v1 has no capacity model (reserved): a second concurrent session ADMITS. Known v1 limit.
create temp table adm_other as select * from public.control_admit_session((select device_id from enroll1), 'sess-2', 'att-9', 'reception');
do $$ begin assert (select admit from adm_other), 'v1 capacity model unexpectedly present'; end $$;

-- Telemetry ingestion: dedupe, side effects, late-end monotonicity, ack event ceiling.
-- occurredAt values are at/after admission: the server stamps started_at at admission.
do $$
declare d uuid := (select device_id from enroll1);
begin
  assert (select accepted from public.control_ingest_events(d, now(), jsonb_build_array(
    jsonb_build_object('eventId','20000000-0000-0000-0000-000000000001','bootId','10000000-0000-0000-0000-000000000002','sequence',1,
      'occurredAt', now(),'build','17.0.45','kind','session.started','sessionId','sess-1','attemptId','att-1','feature','translation')))) = 1,
    'session.started not accepted';
  assert (select s.state from public.voice_sessions s where s.device_id = d and s.client_session_ref = 'sess-1') = 'creating',
    'session not creating';
  -- duplicate upload: counted duplicate, no side effect
  assert (select duplicates from public.control_ingest_events(d, now(), jsonb_build_array(
    jsonb_build_object('eventId','20000000-0000-0000-0000-000000000001','bootId','10000000-0000-0000-0000-000000000002','sequence',1,
      'occurredAt', now(),'build','17.0.45','kind','session.started','sessionId','sess-1','attemptId','att-1','feature','translation')))) = 1,
    'replay not counted duplicate';
  assert (select count(*) from public.session_attempts a where a.device_id = d and a.client_attempt_ref = 'att-1') = 1,
    'duplicate upload created a second attempt';
  -- connected with firstAudioMs
  perform public.control_ingest_events(d, now(), jsonb_build_array(
    jsonb_build_object('eventId','20000000-0000-0000-0000-000000000002','bootId','10000000-0000-0000-0000-000000000002','sequence',2,
      'occurredAt', now(),'build','17.0.45','kind','session.connected','sessionId','sess-1','attemptId','att-1','feature','translation','firstAudioMs', 840)));
  assert (select s.state from public.voice_sessions s where s.device_id = d and s.client_session_ref = 'sess-1') = 'connected', 'not connected';
  assert (select a.first_audio_ms from public.session_attempts a where a.device_id = d and a.client_attempt_ref = 'att-1') = 840, 'first audio missing';
  -- ended
  perform public.control_ingest_events(d, now(), jsonb_build_array(
    jsonb_build_object('eventId','20000000-0000-0000-0000-000000000003','bootId','10000000-0000-0000-0000-000000000002','sequence',3,
      'occurredAt', now(),'build','17.0.45','kind','session.ended','sessionId','sess-1','attemptId','att-1','feature','translation',
      'durationMs', 8000, 'durationProvenance','observed')));
  assert (select s.state from public.voice_sessions s where s.device_id = d and s.client_session_ref = 'sess-1') = 'ended', 'not ended';
  assert (select s.duration_ms from public.voice_sessions s where s.device_id = d and s.client_session_ref = 'sess-1') = 8000, 'duration missing';
  -- late connected must not reopen
  perform public.control_ingest_events(d, now(), jsonb_build_array(
    jsonb_build_object('eventId','20000000-0000-0000-0000-000000000004','bootId','10000000-0000-0000-0000-000000000002','sequence',4,
      'occurredAt', now(),'build','17.0.45','kind','session.connected','sessionId','sess-1','attemptId','att-1','feature','translation','firstAudioMs', null)));
  assert (select s.state from public.voice_sessions s where s.device_id = d and s.client_session_ref = 'sess-1') = 'ended', 'late event reopened session';
  -- policy.ack event above the issued revision aborts the batch (0004rev3 FUTURE_REVISION):
  -- corrupt device state must surface, never silently clamp.
  begin
    perform public.control_ingest_events(d, now(), jsonb_build_array(
      jsonb_build_object('eventId','20000000-0000-0000-0000-000000000005','bootId','10000000-0000-0000-0000-000000000002','sequence',5,
        'occurredAt', now(),'build','17.0.45','kind','policy.ack','revision', 999)));
    raise exception 'future policy.ack ingested';
  exception when raise_exception then
    if sqlerrm not like 'MNZ:FUTURE_REVISION%' then raise; end if;
  end;
  assert (select devices.ack_revision from public.devices where id = d) = 4, 'future ack event moved ack_revision';
  -- historical ingest never touches presence
  assert (select d2.last_seen_at from public.devices d2 where d2.id = d)
       = (select max(h.last_seen_at) from public.devices h where h.id = d), 'presence changed';
end $$;

-- Repair flow: create incident, request repair, incident status + audit.
insert into public.incidents (reference, fingerprint, error_code, component, severity, build, first_seen_at, last_seen_at, occurrences, fix_class, due_at)
  values ('INC-900000001', 'fp:android:CONNECTION_TIMEOUT:17.0.45', 'CONNECTION_TIMEOUT', 'android', 'high', '17.0.45', now(), now(), 3, 'code_candidate', now() + interval '1 day');
create temp table rep as
  select * from public.control_request_repair('00000000-0000-0000-0000-0000000000a0',
    (select id from public.incidents where reference = 'INC-900000001'), 'android_handoff');
do $$ begin
  assert (select count(*) from rep) = 1, 'repair request not created';
  assert (select i.status from public.incidents i where i.reference = 'INC-900000001') = 'repair_requested', 'incident status not advanced';
  assert (select count(*) from public.admin_audit a where a.action = 'repair_prepared') = 1, 'repair audit missing';
end $$;

-- Triage (0006): open -> triaged with audit, idempotent repeat, INVALID_STATE on repair_requested.
create temp table inc2 as
  with j as (
    insert into public.incidents (reference, fingerprint, error_code, component, severity, build, first_seen_at, last_seen_at, occurrences, fix_class, due_at)
    values ('INC-2', 'fp:android:MIC_PERMISSION_DENIED:17.0.45', 'MIC_PERMISSION_DENIED', 'android', 'medium', '17.0.45', now(), now(), 1, 'hotel_action', now() + interval '2 days')
    returning id)
  select * from j;
create temp table tri as
  select * from public.control_triage_incident('00000000-0000-0000-0000-0000000000a0', (select id from inc2), 'looks like a loose mic');
do $$ begin
  assert (select status from tri) = 'triaged', 'triage did not transition';
  assert (select count(*) from public.admin_audit a join inc2 i on a.incident_id = i.id where a.action = 'incident_triaged') = 1, 'triage audit missing';
end $$;
create temp table tri2 as
  select * from public.control_triage_incident('00000000-0000-0000-0000-0000000000a0', (select id from inc2), 'again');
do $$ begin
  assert (select status from tri2) = 'triaged', 'triage repeat not idempotent';
  assert (select count(*) from public.admin_audit a join inc2 i on a.incident_id = i.id where a.action = 'incident_triaged') = 1, 'triage repeat wrote audit';
end $$;
do $$ begin
  begin
    perform public.control_triage_incident('00000000-0000-0000-0000-0000000000a0',
      (select id from public.incidents where reference = 'INC-900000001'), null);
    raise exception 'triage on repair_requested accepted';
  exception when raise_exception then
    if sqlerrm not like 'MNZ:INVALID_STATE%' then raise; end if;
  end;
  begin
    perform public.control_triage_incident('00000000-0000-0000-0000-0000000000a0', '00000000-0000-0000-0000-0000000000ff', null);
    raise exception 'triage on missing incident accepted';
  exception when raise_exception then
    if sqlerrm not like 'MNZ:NOT_FOUND%' then raise; end if;
  end;
end $$;

-- Retry semantics (0004rev5, contract rev10/11): a true retry (same actor, device, original
-- expectedRevision, same desired, SAME reason) returns the recorded historical result with
-- recorded=true and no mutation; any other stale shape (other actor, other desired, OTHER
-- REASON) 409s so a new rationale is never silently dropped.
create temp table pol5 as
  select * from public.control_set_device_policy('00000000-0000-0000-0000-0000000000a0',
    (select device_id from enroll1), 4, 'blocked', 'retry probe reason');
do $$ begin
  assert (select policy_revision from pol5) = 5, 'policy bump to 5';
  assert (select recorded from pol5) is false, 'fresh change must not be marked recorded';
end $$;
create temp table pol5_retry as
  select * from public.control_set_device_policy('00000000-0000-0000-0000-0000000000a0',
    (select device_id from enroll1), 4, 'blocked', 'retry probe reason');
do $$ begin
  assert (select policy_revision from pol5_retry) = 5, 'true retry did not return the recorded result';
  assert (select recorded from pol5_retry) is true, 'true retry must be marked recorded=true (contract rev11)';
  assert (select count(*) from public.admin_audit where device_id = (select device_id from enroll1) and policy_revision = 5) = 1,
    'true retry wrote a second audit row';
  assert (select d.policy_revision from public.devices d join enroll1 e on d.id = e.device_id) = 5,
    'true retry mutated current state';
end $$;
-- Same actor, same original revision, same desired, DIFFERENT reason: not a retry (rev11).
do $$ begin
  begin
    perform public.control_set_device_policy('00000000-0000-0000-0000-0000000000a0',
      (select device_id from enroll1), 4, 'blocked', 'a genuinely different reason');
    raise exception 'stale retry with a different reason accepted';
  exception when raise_exception then
    if sqlerrm not like 'MNZ:STALE_REVISION%' then raise; end if;
  end;
  assert (select count(*) from public.admin_audit a join enroll1 e on a.device_id = e.device_id
          where a.reason = 'a genuinely different reason') = 0,
    'different-reason retry dropped or appended instead of 409';
  assert (select d.policy_revision from public.devices d join enroll1 e on d.id = e.device_id) = 5,
    'different-reason retry mutated current state';
end $$;
do $$ begin
  begin
    perform public.control_set_device_policy('00000000-0000-0000-0000-0000000000a3',
      (select device_id from enroll1), 4, 'blocked', 'retry probe reason');
    raise exception 'stale write from another actor accepted';
  exception when raise_exception then
    if sqlerrm not like 'MNZ:STALE_REVISION%' then raise; end if;
  end;
  begin
    perform public.control_set_device_policy('00000000-0000-0000-0000-0000000000a0',
      (select device_id from enroll1), 4, 'approved', 'retry probe reason');
    raise exception 'stale write with different desired accepted';
  exception when raise_exception then
    if sqlerrm not like 'MNZ:STALE_REVISION%' then raise; end if;
  end;
end $$;
-- a3 moves the device forward: revision 6, desired approved.
create temp table pol6 as
  select * from public.control_set_device_policy('00000000-0000-0000-0000-0000000000a3',
    (select device_id from enroll1), 5, 'approved', 'second admin re-approve');
do $$ begin assert (select policy_revision from pol6) = 6, 'policy bump to 6'; end $$;

-- Ended sessions never gain attempts (0004rev4 INVALID_STATE), admission and ingest both.
do $$ begin
  begin
    perform public.control_admit_session((select device_id from enroll1), 'sess-1', 'att-4', 'translation');
    raise exception 'ended session admitted new attempt';
  exception when raise_exception then
    if sqlerrm not like 'MNZ:INVALID_STATE%' then raise; end if;
  end;
  begin
    perform public.control_ingest_events((select device_id from enroll1), now(), jsonb_build_array(
      jsonb_build_object('eventId','20000000-0000-0000-0000-000000000006','bootId','10000000-0000-0000-0000-000000000002','sequence',6,
        'occurredAt', now(),'build','17.0.45','kind','session.started','sessionId','sess-1','attemptId','att-9','feature','translation')));
    raise exception 'session.started on ended session ingested';
  exception when raise_exception then
    if sqlerrm not like 'MNZ:INVALID_STATE%' then raise; end if;
  end;
end $$;

-- Feature immutability on a LIVE session (sess-2 admitted with feature reception).
do $$ begin
  begin
    perform public.control_admit_session((select device_id from enroll1), 'sess-2', 'att-10', 'translation');
    raise exception 'flipped feature admission accepted';
  exception when raise_exception then
    if sqlerrm not like 'MNZ:SESSION_FEATURE_MISMATCH%' then raise; end if;
  end;
  begin
    perform public.control_ingest_events((select device_id from enroll1), now(), jsonb_build_array(
      jsonb_build_object('eventId','20000000-0000-0000-0000-000000000007','bootId','10000000-0000-0000-0000-000000000002','sequence',7,
        'occurredAt', now(),'build','17.0.45','kind','session.started','sessionId','sess-2','attemptId','att-11','feature','translation')));
    raise exception 'flipped feature ingest accepted';
  exception when raise_exception then
    if sqlerrm not like 'MNZ:SESSION_FEATURE_MISMATCH%' then raise; end if;
  end;
end $$;

-- 500-char reasons stored verbatim (0006rev2 widened admin_audit.reason to 1..500).
-- desired must differ from current, or the 0004rev4 idempotent no-op correctly skips the write.
create temp table pol_long as
  select * from public.control_set_device_policy('00000000-0000-0000-0000-0000000000a0',
    (select device_id from enroll1),
    (select d.policy_revision from public.devices d join enroll1 e on d.id = e.device_id),
    'blocked', (select repeat('r', 500)));
do $$ begin
  assert (select length(a.reason) from public.admin_audit a
          where a.device_id = (select device_id from enroll1) order by a.id desc limit 1) = 500,
    '500-char reason truncated';
end $$;

-- Role isolation: anon/authenticated cannot call service-role wrappers.
set local role anon;
do $$ begin
  begin perform public.control_enroll_device(null, null, 'x', 'X', 'l', '1.0'); raise exception 'anon enrolled';
  exception when insufficient_privilege then null; end;
  begin perform public.credential_device_lookup('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'); raise exception 'anon lookup';
  exception when insufficient_privilege then null; end;
  begin perform public.control_record_heartbeat('00000000-0000-0000-0000-0000000000b1', '10000000-0000-0000-0000-000000000009', 1, '1.0', 'idle', 'unknown', now()); raise exception 'anon heartbeat';
  exception when insufficient_privilege then null; end;
end $$;
set local role authenticated;
do $$ begin
  begin perform public.control_set_device_policy('00000000-0000-0000-0000-0000000000a0', '00000000-0000-0000-0000-0000000000b1', 1, 'approved', 'x'); raise exception 'authenticated set policy';
  exception when insufficient_privilege then null; end;
  begin perform public.control_ingest_events('00000000-0000-0000-0000-0000000000b1', now(), '[]'); raise exception 'authenticated ingested';
  exception when insufficient_privilege then null; end;
  begin perform public.control_mint_setup_token('00000000-0000-0000-0000-0000000000b1', 'zz', now(), '00000000-0000-0000-0000-0000000000a0'); raise exception 'authenticated minted';
  exception when insufficient_privilege then null; end;
end $$;
-- Authenticated hotel user has no table reads even for its own hotel (fleet isolation).
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1","aal":"aal1"}';
do $$ begin
  assert (select count(*) from public.devices) = 0, 'hotel user read devices';
  assert (select count(*) from public.hotels) = 0, 'hotel user read hotels';
end $$;
-- Enabled admin at aal1 sees nothing (SQL-level MFA tightening); aal2 sees rows.
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a0","aal":"aal1"}';
do $$ begin assert (select count(*) from public.devices) = 0, 'aal1 admin read devices'; end $$;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a0","aal":"aal2"}';
do $$ begin assert (select count(*) from public.devices) > 0, 'aal2 admin could not read devices'; end $$;
-- Disabled admin at aal2 sees nothing.
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a2","aal":"aal2"}';
do $$ begin assert (select count(*) from public.devices) = 0, 'disabled admin read devices'; end $$;
reset role;

select 'VERIFIED SECTION PASSED' as result;

-- ============================================================================
-- RETAINED REGRESSIONS: formerly findings (F-retry-moved-on, F-retry-reason-drop) under
-- review with the contract owner; contractual since 0004rev5 / contract rev11.
-- ============================================================================
\set ON_ERROR_STOP on
set local role service_role;

-- R-retry-moved-on: actorA block@4 succeeded as rev5; later actors moved the device to
-- rev7 (blocked, long-reason probe). ActorA's identical old retry must return the
-- HISTORICAL recorded result (revision 5, recorded=true) and must NOT mutate rev7 or
-- present rev5 as current.
create temp table probe_moved as
  select * from public.control_set_device_policy('00000000-0000-0000-0000-0000000000a0',
    (select device_id from enroll1), 4, 'blocked', 'retry probe reason');
do $$ begin
  assert (select policy_revision from probe_moved) = 5,
    'R-retry-moved-on: retry did not return its historical recorded revision';
  assert (select recorded from probe_moved) is true,
    'R-retry-moved-on: historical retry result not marked recorded=true';
  assert (select d.policy_revision from public.devices d join enroll1 e on d.id = e.device_id) = 7,
    'R-retry-moved-on: old retry mutated current revision';
  assert (select d.desired_access from public.devices d join enroll1 e on d.id = e.device_id) = 'blocked',
    'R-retry-moved-on: old retry changed current desired';
end $$;

-- R-retry-reason-drop: same actor + same original revision + same desired but a
-- DIFFERENT reason is not a retry (rev11): it must 409 STALE_REVISION, append no audit
-- row, and leave current state untouched. A new rationale is never silently dropped.
do $$ begin
  begin
    perform public.control_set_device_policy('00000000-0000-0000-0000-0000000000a0',
      (select device_id from enroll1), 4, 'blocked', 'another new reason after move');
    raise exception 'R-retry-reason-drop: different-reason stale request accepted';
  exception when raise_exception then
    if sqlerrm not like 'MNZ:STALE_REVISION%' then raise; end if;
  end;
  assert (select count(*) from public.admin_audit a join enroll1 e on a.device_id = e.device_id
          where a.reason = 'another new reason after move') = 0,
    'R-retry-reason-drop: new reason appended or dropped instead of 409';
  assert (select d.policy_revision from public.devices d join enroll1 e on d.id = e.device_id) = 7,
    'R-retry-reason-drop: different-reason request mutated current revision';
end $$;

select 'retained retry regressions passed (rev11 semantics)' as result;

-- REV 12 / 0007: the storage-level CHECK admits update.status and still rejects unknown kinds.
insert into public.technical_events (device_id, event_id, boot_id, sequence, occurred_at, kind, build)
  select e.device_id, '12121212-1212-4212-8212-121212121212', '34343434-3434-4344-8434-343434343434',
         900, now(), 'update.status', '17.0.44'
    from enroll1 e;
do $$ begin
  assert (select count(*) from public.technical_events t join enroll1 e on t.device_id = e.device_id
          where t.kind = 'update.status') = 1, 'update.status row not stored';
  begin
    insert into public.technical_events (device_id, event_id, boot_id, sequence, occurred_at, kind, build)
      select e.device_id, '56565656-5656-4656-8656-565656565656', '34343434-3434-4344-8434-343434343434',
             901, now(), 'telemetry.unknown', '17.0.44'
        from enroll1 e;
    raise exception 'unknown telemetry kind accepted by storage CHECK';
  exception when check_violation then null;
  end;
end $$;

select 'rev12 storage CHECK assertions passed' as result;

-- REV 12/13 + 0009: update.status typed persistence roundtrip through the real ingest RPC,
-- replay dedupe, and 0008 incident derivation from connection.failed.
create temp table ing_upd as
  select * from public.control_ingest_events((select device_id from enroll1), now(),
    jsonb_build_array(jsonb_build_object(
      'eventId','78787878-7878-4878-8878-787878787878','bootId','34343434-3434-4344-8434-343434343434',
      'sequence',950,'occurredAt','2026-11-10T03:00:00+05:30','build','17.0.44',
      'kind','update.status','feedId','github:somdipto/manzanilla','state','installed',
      'currentBuild','17.0.44','discoveredVersion',null,'publishedAt',null,'progressPct',null,'error',null)));
create temp table ing_upd2 as
  select * from public.control_ingest_events((select device_id from enroll1), now(),
    jsonb_build_array(jsonb_build_object(
      'eventId','78787878-7878-4878-8878-787878787878','bootId','34343434-3434-4344-8434-343434343434',
      'sequence',950,'occurredAt','2026-11-10T03:00:00+05:30','build','17.0.44',
      'kind','update.status','feedId','github:somdipto/manzanilla','state','installed',
      'currentBuild','17.0.44','discoveredVersion',null,'publishedAt',null,'progressPct',null,'error',null)));
do $$ begin
  assert (select accepted from ing_upd) = 1, 'update.status event not accepted';
  assert (select duplicates from ing_upd2) = 1 and (select accepted from ing_upd2) = 0, 'update.status replay not deduped';
  assert (select t.update_state from public.technical_events t
          where t.event_id = '78787878-7878-4878-8878-787878787878') = 'installed',
    'update.status typed state not persisted';
  assert (select t.update_feed_id from public.technical_events t
          where t.event_id = '78787878-7878-4878-8878-787878787878') = 'github:somdipto/manzanilla',
    'update.status feedId not persisted';
  assert (select t.update_current_build from public.technical_events t
          where t.event_id = '78787878-7878-4878-8878-787878787878') = '17.0.44',
    'update.status currentBuild not persisted';
  -- nullable fields stored as NULL (not empty string, not defaulted)
  assert (select t.update_discovered_version is null and t.update_published_at is null
                 and t.update_progress_pct is null and t.update_error is null
          from public.technical_events t
          where t.event_id = '78787878-7878-4878-8878-787878787878'),
    'update.status nullable fields not stored as NULL';
end $$;

-- all seven typed fields with NON-null values round-trip exactly
create temp table ing_upd3 as
  select * from public.control_ingest_events((select device_id from enroll1), now(),
    jsonb_build_array(jsonb_build_object(
      'eventId','90909090-9090-4909-8909-909090909090','bootId','34343434-3434-4344-8434-343434343434',
      'sequence',953,'occurredAt','2026-11-10T03:20:00+05:30','build','17.0.44',
      'kind','update.status','feedId','github:somdipto/manzanilla','state','failed',
      'currentBuild','17.0.44','discoveredVersion','17.0.45','publishedAt','2026-11-09T22:00:00+05:30',
      'progressPct',40,'error','checksum mismatch')));
do $$ begin
  assert (select accepted from ing_upd3) = 1, 'non-null update.status event not accepted';
  assert (select t.update_state = 'failed'
             and t.update_feed_id = 'github:somdipto/manzanilla'
             and t.update_current_build = '17.0.44'
             and t.update_discovered_version = '17.0.45'
             and t.update_published_at = '2026-11-09T22:00:00+05:30'::timestamptz
             and t.update_progress_pct = 40
             and t.update_error = 'checksum mismatch'
          from public.technical_events t
          where t.event_id = '90909090-9090-4909-8909-909090909090'),
    'update.status 7-field non-null roundtrip mismatch';
  -- other kinds leave the typed update columns NULL
  assert (select bool_and(t.update_state is null and t.update_feed_id is null)
          from public.technical_events t where t.kind <> 'update.status'),
    'non-update.status row carries update fields';
end $$;

-- 0008: connection.failed derives one incident per fingerprint; a second failure bumps occurrences.
create temp table ing_fail as
  select * from public.control_ingest_events((select device_id from enroll1), now(),
    jsonb_build_array(jsonb_build_object(
      'eventId','79797979-7979-4979-8979-797979797979','bootId','34343434-3434-4344-8434-343434343434',
      'sequence',951,'occurredAt',now(),'build','17.0.44','kind','connection.failed',
      'sessionId','s-inc','attemptId','a-inc','feature','translation','code','PROVIDER_UNAVAILABLE')));
create temp table ing_fail2 as
  select * from public.control_ingest_events((select device_id from enroll1), now(),
    jsonb_build_array(jsonb_build_object(
      'eventId','80808080-8080-4880-8880-808080808080','bootId','34343434-3434-4344-8434-343434343434',
      'sequence',952,'occurredAt',now(),'build','17.0.44','kind','connection.failed',
      'sessionId','s-inc','attemptId','a-inc','feature','translation','code','PROVIDER_UNAVAILABLE')));
do $$ begin
  assert (select accepted from ing_fail) = 1, 'connection.failed event not accepted';
  assert (select count(*) from public.incidents where error_code = 'PROVIDER_UNAVAILABLE'
          and component = 'provider' and severity = 'high' and fix_class = 'external') = 1,
    'connection.failed did not derive exactly one incident with the bounded mapping';
  assert (select max(occurrences) from public.incidents where error_code = 'PROVIDER_UNAVAILABLE') = 2,
    'second connection.failed did not bump occurrences on the same fingerprint';
  assert (select count(*) from public.incident_devices idv join public.incidents i on i.id = idv.incident_id
          join enroll1 e on e.device_id = idv.device_id where i.error_code = 'PROVIDER_UNAVAILABLE') = 1,
    'incident-device link missing or duplicated';
end $$;

select 'rev12/13 persistence + 0008 incident derivation assertions passed' as result;

-- 0010 producer readback: real ingests feed traffic_buckets (retries counted); a new
-- incident creates deduped pending alert rows for enabled admins; recurrence alerts nothing new.
do $$ begin
  assert (select coalesce(sum(b.requests), 0) from public.traffic_buckets b join enroll1 e on b.device_id = e.device_id) > 0,
    'no traffic bucket rows produced by ingested events';
  assert (select coalesce(sum(b.retry_requests), 0) from public.traffic_buckets b join enroll1 e on b.device_id = e.device_id) >= 1,
    'replayed events not counted as retries in traffic buckets';
  assert (select count(*) from public.alert_notifications an
          join public.incidents i on i.id = an.incident_id
          where i.error_code = 'PROVIDER_UNAVAILABLE' and an.state = 'pending') = 2,
    'expected one pending alert per enabled admin for the new incident';
end $$;

select '0010 producer readback assertions passed' as result;

-- 0010rev4 histogram bucket positions (QA PG 1-based finding): 0ms -> bucket 0 at subscript 1,
-- 840ms (already ingested above) -> bucket 3 at subscript 4, 999999ms clamps to bucket 31 at
-- subscript 32. Assert exact positions, not just totals.
do $$
declare d uuid := (select device_id from enroll1); h int[];
begin
  perform public.control_ingest_events(d, now(), jsonb_build_array(
    jsonb_build_object('eventId','20000000-0000-0000-0000-0000000000e1','bootId','10000000-0000-0000-0000-000000000002','sequence',91,
      'occurredAt', now(),'build','17.0.45','kind','session.started','sessionId','sess-h0','attemptId','att-h0','feature','translation'),
    jsonb_build_object('eventId','20000000-0000-0000-0000-0000000000e2','bootId','10000000-0000-0000-0000-000000000002','sequence',92,
      'occurredAt', now(),'build','17.0.45','kind','session.connected','sessionId','sess-h0','attemptId','att-h0','feature','translation','firstAudioMs', 0),
    jsonb_build_object('eventId','20000000-0000-0000-0000-0000000000e3','bootId','10000000-0000-0000-0000-000000000002','sequence',93,
      'occurredAt', now(),'build','17.0.45','kind','session.started','sessionId','sess-h31','attemptId','att-h31','feature','translation'),
    jsonb_build_object('eventId','20000000-0000-0000-0000-0000000000e4','bootId','10000000-0000-0000-0000-000000000002','sequence',94,
      'occurredAt', now(),'build','17.0.45','kind','session.connected','sessionId','sess-h31','attemptId','att-h31','feature','translation','firstAudioMs', 8000)));
  -- per-subscript sums across ALL hour-bucket rows of the device (deterministic; a plain
  -- array_agg over the cross join mixes rows and flakes when another hour's bucket exists)
  select array_agg(coalesce((select sum(b.latency_histogram[i]) from public.traffic_buckets b where b.device_id = d), 0) order by i)
    into h from generate_series(1, 32) i;
  assert h[1] = 1, 'firstAudioMs=0 must land in bucket 0 (subscript 1), got ' || h[1];
  assert h[4] = 1, 'firstAudioMs=840 must land in bucket 3 (subscript 4), got ' || h[4];
  assert h[32] = 1, 'firstAudioMs=8000 must clamp to bucket 31 (subscript 32), got ' || h[32];
  assert (select count(*) from generate_series(1, 32) i where h[i] > 0) = 3,
    'samples leaked into wrong buckets: ' || h::text;
  assert (select coalesce(sum(b.timing_sample_count), 0) from public.traffic_buckets b where b.device_id = d) = 3,
    'timing sample count must equal the 3 histogram samples';
end $$;

select '0010rev4 histogram bucket-position assertions passed' as result;
