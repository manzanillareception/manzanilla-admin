-- Run via run.sh after baseline + 001..003 migrations. Each assertion raises on failure.
\set ON_ERROR_STOP on
begin;
set local role postgres;
insert into public.hotels (id, name, city) values ('00000000-0000-0000-0000-0000000000a1', 'T', 'C') on conflict do nothing;
insert into private.provisioning_jobs (id, hotel_id, email, kind, deadline_at)
  values ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000a1','a@b.test','welcome', now()+interval '23 hours');

set local role service_role;
do $$ begin
  -- claim: first wins, second gets null while lease is live
  assert public.claim_provisioning_job('00000000-0000-0000-0000-0000000000b1','w1',60) is not null, 'w1 claims';
  assert public.claim_provisioning_job('00000000-0000-0000-0000-0000000000b1','w2',60) is null, 'w2 refused';
  -- fenced write: wrong worker writes nothing, right worker writes
  assert not public.provisioning_stage_write('00000000-0000-0000-0000-0000000000b1','w2','auth_created'), 'wrong worker fenced';
  assert public.provisioning_stage_write('00000000-0000-0000-0000-0000000000b1','w1','auth_created'), 'holder writes';
end $$;
reset role;
update private.provisioning_jobs set lease_until = now() - interval '1 second'; -- simulate expiry
set local role service_role;
do $$ begin
  assert not public.provisioning_stage_write('00000000-0000-0000-0000-0000000000b1','w1','sent'), 'expired lease fenced';
  assert public.claim_provisioning_job('00000000-0000-0000-0000-0000000000b1','w2',60) is not null, 'expired lease reclaimable';
  assert not public.release_provisioning_job('00000000-0000-0000-0000-0000000000b1','w1'), 'non-holder cannot release';
  -- transition guard (NOT RUN): illegal moves are refused while the lease is held
  assert public.claim_provisioning_job('00000000-0000-0000-0000-0000000000b1','w2',60) is null; -- w2 already holds
  assert public.provisioning_stage_write('00000000-0000-0000-0000-0000000000b1','w2','sent', p_provider_message_id => 'm1'), 'auth_created -> sent legal';
  assert not public.provisioning_stage_write('00000000-0000-0000-0000-0000000000b1','w2','pending'), 'sent -> pending refused';
  assert not public.provisioning_stage_write('00000000-0000-0000-0000-0000000000b1','w2','auth_created'), 'sent -> auth_created refused';
  assert public.provisioning_stage_write('00000000-0000-0000-0000-0000000000b1','w2','done', p_set_sealed => true), 'sent -> done legal, wipes sealed';
  assert (select sealed_password is null from private.provisioning_jobs where id='00000000-0000-0000-0000-0000000000b1');
  -- delivery ordering
  insert into public.email_deliveries (provider_message_id, kind) values ('m1','welcome');
  assert public.advance_email_delivery('m1','delivered', now()) = 'delivered';
  assert public.advance_email_delivery('m1','delayed', now()) = 'delivered', 'no regression';
  assert public.advance_email_delivery('m1','accepted', now()) = 'delivered', 'no regression 2';
  assert public.advance_email_delivery('m1','bounced', now()) = 'bounced', 'late bounce advances';
  assert public.advance_email_delivery('m1','delivered', now()) = 'bounced', 'terminal';
  assert public.advance_email_delivery('m1','complained', now()) = 'bounced', 'first terminal wins over complained';
  insert into public.email_deliveries (provider_message_id, kind) values ('m2','welcome');
  assert public.advance_email_delivery('m2','complained', now()) = 'complained', 'complained is a state';
  assert public.advance_email_delivery('m2','failed', now()) = 'complained', 'complained stays';
  assert public.advance_email_delivery('unknown','accepted', now()) is null, 'unknown id returns null';
end $$;
-- privilege checks: anon/authenticated cannot call privileged wrappers
set local role anon;
do $$ begin
  begin perform public.claim_provisioning_job('00000000-0000-0000-0000-0000000000b1','x',1); raise exception 'anon allowed';
  exception when insufficient_privilege then null; end;
end $$;
set local role authenticated;
do $$ begin
  begin perform public.advance_email_delivery('m1','failed', now()); raise exception 'authenticated allowed';
  exception when insufficient_privilege then null; end;
  begin perform public.requeue_provisioning_job('00000000-0000-0000-0000-0000000000b1'); raise exception 'authenticated allowed';
  exception when insufficient_privilege then null; end;
  begin perform 1 from private.provisioning_jobs; raise exception 'private table readable';
  exception when insufficient_privilege then null; end;
end $$;
-- MFA tightening (NOT RUN): a real ENABLED admin sees rows at aal2 but zero at aal1.
reset role;
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000c1', 'admin@test.invalid') on conflict do nothing;
insert into public.admin_members (user_id, enabled) values ('00000000-0000-0000-0000-0000000000c1', true) on conflict (user_id) do update set enabled = true;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","aal":"aal2"}';
set local role authenticated;
do $$ begin assert (select count(*) from public.provisioning_job_status()) >= 1, 'positive control: aal2 admin sees job'; end $$;
reset role;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","aal":"aal1"}';
set local role authenticated;
do $$ begin
  assert (select count(*) from public.provisioning_job_status()) = 0, 'aal1 admin gets no rows';
  assert (select count(*) from public.email_deliveries) = 0, 'aal1 admin direct RLS read gets no rows';
  assert (select count(*) from public.hotel_users) = 0, 'aal1 hotel_users read empty';
end $$;
-- Regression for live 500 on recovery (NOT RUN): create_recovery_job must return rows, not a type-mismatch error.
reset role;
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000d1', 'hotel@test.invalid') on conflict do nothing;
insert into public.hotel_users (hotel_id, auth_user_id, email)
  values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000d1', 'hotel@test.invalid') on conflict do nothing;
set local role service_role;
do $$
declare v_job uuid; v_cnt int;
begin
  select job_id into v_job from public.create_recovery_job(
    '00000000-0000-0000-0000-0000000000a1', 'guide', '00000000-0000-0000-0000-0000000000c1', gen_random_uuid());
  assert v_job is not null, 'recovery job id returned';
  select count(*) into v_cnt from public.get_provisioning_job(v_job) where kind = 'guide' and status = 'pending' and sealed_password is null;
  assert v_cnt = 1, 'guide job persisted pending with no payload';
  -- same hotel+kind again reuses the active job
  assert (select job_id from public.create_recovery_job('00000000-0000-0000-0000-0000000000a1','guide','00000000-0000-0000-0000-0000000000c1', gen_random_uuid())) = v_job, 'reuses active job';
end $$;
reset role;
-- EXECUTE privileges on EVERY public security-definer function (NOT RUN): anon/authenticated denied.
-- Functions meant for admins/users are listed in the allow-list below; everything else must be service_role only.
reset role;
do $$
declare r record; n int := 0;
begin
  for r in
    select p.oid, p.oid::regprocedure::text as sig, p.proname
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public' and p.prosecdef
      and p.proname not in ('provisioning_job_status')  -- admin read function: authenticated allowed by design
  loop
    n := n + 1;
    assert not has_function_privilege('anon', r.oid, 'execute'), 'anon can execute ' || r.sig;
    assert not has_function_privilege('authenticated', r.oid, 'execute'), 'authenticated can execute ' || r.sig;
    assert not has_function_privilege('public', r.oid, 'execute'), 'PUBLIC can execute ' || r.sig;
    assert has_function_privilege('service_role', r.oid, 'execute'), 'service_role cannot execute ' || r.sig;
  end loop;
  assert n > 0, 'no security definer functions found';
end $$;
rollback;
select 'email db tests passed' as result;
