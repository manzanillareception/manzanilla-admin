-- Email/provisioning RPCs (email lane migration requests a-d + main's markSeen flag) and a
-- grants fix: 0001's new public tables never got service_role grants (RLS bypass does not
-- replace table privileges). All functions security definer, service_role ONLY.
begin;

-- Grants fix for 0001 tables.
grant all on public.hotel_users to service_role;
grant all on public.email_deliveries to service_role;
grant all on public.alert_notifications to service_role;

-- (a) Read one provisioning job for the leased worker. Returns sealed_password: service_role ONLY.
create or replace function public.get_provisioning_job(p_job_id uuid)
returns table (id uuid, hotel_id uuid, hotel_name text, email citext, kind text, status text,
               auth_user_id uuid, sealed_password text, deadline_at timestamptz,
               provider_message_id text, last_error text, created_at timestamptz)
language sql stable security definer set search_path = ''
as $$
  select j.id, j.hotel_id, h.name, j.email, j.kind, j.status, j.auth_user_id,
         j.sealed_password, j.deadline_at, j.provider_message_id, j.last_error, j.created_at
  from private.provisioning_jobs j
  join public.hotels h on h.id = j.hotel_id
  where j.id = p_job_id;
$$;
revoke all on function public.get_provisioning_job(uuid) from public, anon, authenticated;
grant execute on function public.get_provisioning_job(uuid) to service_role;

-- (b) Create hotel + pending welcome job in one transaction. Idempotent: an existing ACTIVE
-- job for the same email returns the existing ids instead of duplicating. The password is
-- generated and sealed by the caller at creation (transition guards make pending->pending
-- illegal, so the seal cannot be a stage write).
create or replace function public.create_hotel_with_job(
  p_name text, p_city text, p_email citext, p_sealed_password text,
  p_deadline_at timestamptz, p_admin uuid, p_job_id uuid)
returns table (hotel_id uuid, job_id uuid, already_existed boolean)
language plpgsql security definer set search_path = ''
as $$
declare
  v_hotel uuid;
  v_job uuid;
begin
  perform private.require_enabled_admin(p_admin);
  -- Welcome-kind filter (email review): an active guide/recovery job for the same email
  -- must not be mistaken for this hotel's welcome job.
  select j.hotel_id, j.id into v_hotel, v_job
  from private.provisioning_jobs j
  where j.email = p_email and j.kind = 'welcome'
    and j.status in ('pending', 'auth_created', 'sent')
  limit 1;
  if v_job is not null then
    return query select v_hotel, v_job, true; -- existing sealed password kept; caller's discarded
    return;
  end if;
  insert into public.hotels (name, city) values (p_name, p_city) returning hotels.id into v_hotel;
  insert into private.provisioning_jobs (id, hotel_id, email, kind, sealed_password, deadline_at)
  values (p_job_id, v_hotel, p_email, 'welcome', p_sealed_password, p_deadline_at)
  returning id into v_job;
  return query select v_hotel, v_job, false;
end $$;
-- rev2 changed the signature to 7 args; drop any pre-rev2 6-arg overload a dev database may hold.
drop function if exists public.create_hotel_with_job(text, text, citext, text, timestamptz, uuid);
revoke all on function public.create_hotel_with_job(text, text, citext, text, timestamptz, uuid, uuid) from public, anon, authenticated;
grant execute on function public.create_hotel_with_job(text, text, citext, text, timestamptz, uuid, uuid) to service_role;

-- (e, implied by b) Link a created Auth user to its hotel after the auth_created stage write.
-- Idempotent on the primary key; the hotel_users trigger keeps admins out.
create or replace function public.link_hotel_user(p_hotel_id uuid, p_auth_user_id uuid, p_email citext)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.hotel_users (hotel_id, auth_user_id, email)
  values (p_hotel_id, p_auth_user_id, p_email)
  on conflict (hotel_id, auth_user_id) do nothing;
end $$;
revoke all on function public.link_hotel_user(uuid, uuid, citext) from public, anon, authenticated;
grant execute on function public.link_hotel_user(uuid, uuid, citext) to service_role;

-- (c) Recovery job (guide or reset_link; kind 'guide'/'recovery'). No sealed password:
-- guide mail carries no credentials; reset_link uses Supabase generateLink (blocked on the
-- production Site URL / redirect allowlist until deployment config exists).
-- rev6: OUT email is text, not citext - the citext extension schema differs between local PG
-- and hosted Supabase, and a schema-qualified cast or citext OUT type is not portable. DROP
-- first because the OUT column type changes under CREATE OR REPLACE on existing databases.
drop function if exists public.create_recovery_job(uuid, text, uuid, uuid);
create or replace function public.create_recovery_job(p_hotel_id uuid, p_kind text, p_admin uuid, p_job_id uuid)
returns table (job_id uuid, email text)
language plpgsql security definer set search_path = ''
as $$
declare
  -- text, not citext: with search_path='' the extension type is invisible at body compile time.
  v_email text;
  v_job uuid;
begin
  perform private.require_enabled_admin(p_admin);
  if p_kind not in ('guide', 'recovery') then
    raise exception 'MNZ:VALIDATION_FAILED: recovery kind must be guide or recovery';
  end if;
  select u.email into v_email from public.hotel_users u where u.hotel_id = p_hotel_id limit 1;
  if v_email is null then
    raise exception 'MNZ:NOT_FOUND: hotel has no user';
  end if;
  -- Reuse an active recovery job for the same hotel+kind rather than duplicating.
  select j.id into v_job from private.provisioning_jobs j
   where j.hotel_id = p_hotel_id and j.kind = p_kind
     and j.status in ('pending', 'auth_created', 'sent')
   limit 1;
  if v_job is null then
    insert into private.provisioning_jobs (id, hotel_id, email, kind, deadline_at)
    values (p_job_id, p_hotel_id, v_email, p_kind, now() + interval '23 hours')
    returning id into v_job;
  end if;
  return query select v_job, v_email;
end $$;
-- rev2 changed the signature to 4 args; drop any pre-rev2 3-arg overload a dev database may hold.
drop function if exists public.create_recovery_job(uuid, text, uuid);
revoke all on function public.create_recovery_job(uuid, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.create_recovery_job(uuid, text, uuid, uuid) to service_role;

-- (d) Auth-user lookup by email for reconciliation (replaces bounded listUsers scans).
-- Returns the server-set provisioning marker from app_metadata.
create or replace function public.lookup_auth_user_by_email(p_email citext)
returns table (id uuid, provisioning_job_id uuid)
language sql stable security definer set search_path = ''
as $$
  -- Robust cast (email review): a non-UUID marker (manually created account) yields null,
  -- never a cast error.
  select u.id,
         case when u.raw_app_meta_data ->> 'provisioning_job_id'
                   ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
              then (u.raw_app_meta_data ->> 'provisioning_job_id')::uuid end
  from auth.users u
  where lower(u.email) = lower(p_email);
$$;
revoke all on function public.lookup_auth_user_by_email(citext) from public, anon, authenticated;
grant execute on function public.lookup_auth_user_by_email(citext) to service_role;

-- Webhook dedupe (main's flag): private.webhook_events is not PostgREST-exposed, so the
-- DeliveryStore must not insert directly. Returns false when the svix id was already seen.
create or replace function public.mark_webhook_seen(p_svix_id text)
returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  insert into private.webhook_events (svix_id) values (p_svix_id) on conflict do nothing;
  return found;
end $$;
revoke all on function public.mark_webhook_seen(text) from public, anon, authenticated;
grant execute on function public.mark_webhook_seen(text) to service_role;

-- Retention purge for webhook dedupe rows (email lane request): private table, so the
-- retention job calls this RPC instead of touching the table via PostgREST.
create or replace function public.purge_webhook_events(p_older_than interval)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_count int;
begin
  delete from private.webhook_events where received_at < now() - p_older_than;
  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke all on function public.purge_webhook_events(interval) from public, anon, authenticated;
grant execute on function public.purge_webhook_events(interval) to service_role;

commit;
