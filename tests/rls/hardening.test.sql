\set ON_ERROR_STOP on
begin;
do $$ declare r jsonb; begin
  assert not has_function_privilege('anon','public.control_check_rate_limit(text,integer,integer)','execute');
  assert not has_function_privilege('authenticated','public.control_check_rate_limit(text,integer,integer)','execute');
  assert (select relrowsecurity from pg_class where oid = 'private.rate_limit_buckets'::regclass);
  assert not has_table_privilege('anon','private.rate_limit_buckets','select');
end $$;
set local role service_role;
do $$ declare r jsonb; begin
  r := public.control_check_rate_limit(repeat('a',64),2,1000); assert (r->>'allowed')::boolean;
  r := public.control_check_rate_limit(repeat('a',64),2,1000); assert (r->>'allowed')::boolean;
  r := public.control_check_rate_limit(repeat('a',64),2,1000); assert not (r->>'allowed')::boolean; assert (r->>'retry_after_ms')::int > 0;
  r := public.control_check_rate_limit(repeat('b',64),2,1000); assert (r->>'allowed')::boolean, 'keys isolated';
end $$;
reset role;
update private.rate_limit_buckets set expires_at = clock_timestamp() - interval '1 second';
set local role service_role;
do $$ begin
  assert (public.control_check_rate_limit(repeat('a',64),2,1000)->>'allowed')::boolean, 'expired window resets';
end $$;
reset role;
insert into public.hotels(id,name,city) values ('f0000000-0000-4000-8000-000000000001','Hardening','Test');
insert into private.provisioning_jobs(id,hotel_id,email,kind,status,deadline_at,provider_message_id,sealed_password)
values ('f0000000-0000-4000-8000-000000000002','f0000000-0000-4000-8000-000000000001','hardening@example.test','welcome','sent',now()+interval '1 hour','hardening-m1','sealed');
insert into public.email_deliveries(provider_message_id,job_id,kind,state) values ('hardening-m1','f0000000-0000-4000-8000-000000000002','welcome','accepted');
set local role service_role;
select public.advance_email_delivery('hardening-m1','delivered',now());
reset role;
do $$ begin
  assert (select status='done' and sealed_password is null from private.provisioning_jobs where id='f0000000-0000-4000-8000-000000000002');
end $$;
set local role service_role;
select public.advance_email_delivery('hardening-m1','bounced',now());
select public.advance_email_delivery('hardening-m1','delivered',now());
select public.advance_email_delivery('hardening-m1','bounced',now());
reset role;
do $$ begin
  assert (select status='needs_attention' and last_error='email_bounced' from private.provisioning_jobs where id='f0000000-0000-4000-8000-000000000002');
end $$;
-- A second job proves complaint status separately, and late delivered cannot recover it.
insert into private.provisioning_jobs(id,hotel_id,email,kind,status,deadline_at,provider_message_id)
values ('f0000000-0000-4000-8000-000000000003','f0000000-0000-4000-8000-000000000001','hardening@example.test','recovery','sent',now()+interval '1 hour','hardening-m2');
insert into public.email_deliveries(provider_message_id,job_id,kind,state) values ('hardening-m2','f0000000-0000-4000-8000-000000000003','recovery','accepted');
set local role service_role;
select public.advance_email_delivery('hardening-m2','complained',now());
select public.advance_email_delivery('hardening-m2','delivered',now());
reset role;
do $$ begin
  assert (select status='needs_attention' and last_error='email_complained' from private.provisioning_jobs where id='f0000000-0000-4000-8000-000000000003');
end $$;
insert into public.email_deliveries(provider_message_id,job_id,kind,state)
values ('hardening-old','f0000000-0000-4000-8000-000000000003','recovery','accepted');
update private.provisioning_jobs set status='sent', last_error=null, provider_message_id='hardening-new'
where id='f0000000-0000-4000-8000-000000000003';
set local role service_role;
select public.advance_email_delivery('hardening-old','delivered',now());
reset role;
do $$ begin
  assert (select status='sent' and provider_message_id='hardening-new' from private.provisioning_jobs where id='f0000000-0000-4000-8000-000000000003'), 'old message cannot finalize new retry';
end $$;
rollback;
