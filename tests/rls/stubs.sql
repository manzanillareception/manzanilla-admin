do $$ begin
  if not exists (select from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end $$;
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_app_meta_data jsonb not null default '{}'::jsonb
);
create or replace function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
-- Real Supabase's service_role can read auth.users (admin/bypass role; 0010's alert
-- producer joins it for recipients). anon/authenticated never can.
grant select on auth.users to service_role;
-- Supabase grants table privileges to anon/authenticated/service_role by default and lets
-- RLS do the filtering. Mirror that so tests exercise RLS, not missing table grants.
alter default privileges in schema public grant select, insert, update, delete on tables to anon, authenticated, service_role;
