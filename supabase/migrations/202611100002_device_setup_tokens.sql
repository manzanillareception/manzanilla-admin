-- One-use device setup tokens for POST /api/v1/devices/enroll (contract v1, clarification 20261110).
-- Server-only: only token hashes are stored; plaintext is returned once by the admin mint route.
begin;

-- MFA at the SQL layer (contract v1, 2026-11-10 ruling): an enabled admin's direct PostgREST
-- reads require AAL2, matching the route-level helper. This single replacement tightens EVERY
-- baseline admin-read policy at once (they all call this function). service_role bypasses RLS
-- and never relies on this predicate. The no-factor enrollment flow touches only Supabase Auth
-- APIs, so it is unaffected. Local disposable-Postgres tests must stub auth.jwt() to emit aal.
create or replace function private.is_enabled_admin()
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.admin_members m
    where m.user_id = (select auth.uid()) and m.enabled
  ) and (select coalesce(auth.jwt() ->> 'aal', '') = 'aal2');
$$;
revoke all on function private.is_enabled_admin() from public, anon;
grant execute on function private.is_enabled_admin() to authenticated, service_role;

create table private.device_setup_tokens (
  token_hash text primary key check (token_hash ~ '^[a-f0-9]{64}$'),
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  consumed_by_device uuid references public.devices(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index device_setup_tokens_hotel_idx on private.device_setup_tokens(hotel_id);
revoke all on private.device_setup_tokens from public, anon, authenticated;
grant select, insert, update on private.device_setup_tokens to service_role;

-- Atomic one-use consumption: a token is consumable once, while unexpired.
create or replace function private.consume_setup_token(p_token_hash text, p_device_id uuid)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  v_hotel uuid;
begin
  update private.device_setup_tokens
     set consumed_at = now(), consumed_by_device = p_device_id
   where token_hash = p_token_hash
     and consumed_at is null
     and expires_at > now()
  returning hotel_id into v_hotel;
  return v_hotel; -- null: invalid, expired or already consumed
end $$;
revoke all on function private.consume_setup_token(text, uuid) from public, anon, authenticated;
grant execute on function private.consume_setup_token(text, uuid) to service_role;

commit;
