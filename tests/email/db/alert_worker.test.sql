-- 0011 alert worker SQL: claim fencing, terminal failure, delivered->sent regression (fresh rows).
begin;
insert into auth.users (id, email) values ('11111111-1111-4111-8111-111111111111', 'aw-test@example.com') on conflict do nothing;
insert into public.admin_members (user_id, enabled) values ('11111111-1111-4111-8111-111111111111', true) on conflict do nothing;
insert into public.incidents (reference, fingerprint, error_code, component, severity, build, fix_class, occurrences, first_seen_at, last_seen_at, due_at)
  values ('INC-901', 'AW|test|1.0.0', 'CONNECTION_TIMEOUT', 'network', 'medium', '1.0.0', 'external', 1, now(), now(), now() + interval '4 hours');
-- no manual alert insert: the 0010 producer trigger creates the row for every enabled admin,
-- which now includes aw-test@example.com (this also proves the producer on a fresh incident).
-- claim by worker A; worker B cannot see the row
do $$
declare v_a uuid; v_b uuid; v_id uuid; v_state text;
begin
  select id into v_id from public.alert_notifications where recipient = 'aw-test@example.com';
  select c into v_a from private.claim_alert_notifications('worker-A', 1000, 120) c where c = v_id;
  if v_a is distinct from v_id then raise exception 'worker A failed to claim'; end if;
  select c into v_b from private.claim_alert_notifications('worker-B', 1000, 120) c where c = v_id;
  if v_b is not null then raise exception 'worker B saw a leased row'; end if;
  -- fenced mark: wrong worker rejected
  begin
    perform private.mark_alert_attempt(v_id, 'worker-B', true);
    raise exception 'unfenced mark succeeded';
  exception when raise_exception then null; when others then
    if sqlerrm not like 'MNZ:CONFLICT%' then raise; end if;
  end;
  -- success path
  select private.mark_alert_attempt(v_id, 'worker-A', true) into v_state;
  if v_state <> 'sent' then raise exception 'mark ok did not advance to sent: %', v_state; end if;
  -- delivered -> sent regression: rank RPC must not regress state
  perform private.advance_alert_notification(v_id, 'delivered');
  perform private.advance_alert_notification(v_id, 'sent');
  select state into v_state from public.alert_notifications where id = v_id;
  if v_state <> 'delivered' then raise exception 'delivered regressed to %', v_state; end if;
end $$;
-- terminal failure: 5 failed attempts -> failed, operator-visible
do $$
declare v_id uuid; v_state text;
begin
  insert into public.alert_notifications (incident_id, recipient)
    select id, 'aw2@example.com' from public.incidents where reference = 'INC-901' returning id into v_id;
  for i in 1..5 loop
    perform private.claim_alert_notifications('worker-C', 1000, 120);
    v_state := private.mark_alert_attempt(v_id, 'worker-C', false);
    -- clear backoff so the next loop iteration can claim immediately
    update public.alert_notifications set next_attempt_at = null where id = v_id;
  end loop;
  if v_state <> 'failed' then raise exception '5th failure did not terminate: %', v_state; end if;
end $$;
select 'alert worker db tests passed';
rollback;
