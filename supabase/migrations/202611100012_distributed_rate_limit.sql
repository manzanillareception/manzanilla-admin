-- Additive, live-safe: fleet-wide fixed windows. Service-only RPC, no public table grants.
begin;
create table if not exists private.rate_limit_buckets (
  key_hash text primary key,
  expires_at timestamptz not null,
  hits integer not null check (hits >= 1)
);
create index if not exists rate_limit_buckets_expiry on private.rate_limit_buckets(expires_at);
alter table private.rate_limit_buckets enable row level security;
revoke all on private.rate_limit_buckets from public, anon, authenticated;

create or replace function public.control_check_rate_limit(p_key text, p_limit integer, p_window_ms integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  t timestamptz := clock_timestamp();
  b private.rate_limit_buckets%rowtype;
begin
  if p_key is null or p_key !~ '^[0-9a-f]{64}$' or p_limit is null or p_limit < 1 or p_limit > 10000
    or p_window_ms is null or p_window_ms < 1000 or p_window_ms > 3600000 then
    raise exception 'invalid rate limit arguments';
  end if;
  -- Bounded garbage collection; SKIP LOCKED avoids blocking concurrent callers.
  if pg_try_advisory_xact_lock(721641120012) then
  with expired as (
    select key_hash from private.rate_limit_buckets where expires_at <= t
    order by expires_at limit 100 for update skip locked
  ) delete from private.rate_limit_buckets where key_hash in (select key_hash from expired);
  end if;

  insert into private.rate_limit_buckets as current (key_hash, expires_at, hits)
  values (p_key, t + p_window_ms * interval '1 millisecond', 1)
  on conflict (key_hash) do update set
    hits = case when current.expires_at <= t then 1 else least(current.hits + 1, p_limit + 1) end,
    expires_at = case when current.expires_at <= t then excluded.expires_at else current.expires_at end
  returning * into b;
  return jsonb_build_object('allowed', b.hits <= p_limit,
    'retry_after_ms', case when b.hits <= p_limit then 0 else greatest(1, ceil(extract(epoch from (b.expires_at - t)) * 1000)::integer) end);
end $$;
revoke all on function public.control_check_rate_limit(text,integer,integer) from public, anon, authenticated;
grant execute on function public.control_check_rate_limit(text,integer,integer) to service_role;
commit;
