-- 0011 rev1: alert send worker support (contract REV 14). Lease-fenced claiming so concurrent
-- workers never double-send; bounded retry with terminal operator-visible 'failed'.
alter table public.alert_notifications
  add column if not exists lease_owner text,
  add column if not exists lease_until timestamptz;

-- Claim up to p_limit due rows atomically; expired leases are reclaimable. Returns the claimed ids.
create or replace function private.claim_alert_notifications(p_worker text, p_limit int, p_lease_seconds int)
returns setof uuid language plpgsql security definer set search_path = ''
as $$
begin
  return query
    with due as (
      select a.id from public.alert_notifications a
      where a.state = 'pending'
        and (a.next_attempt_at is null or a.next_attempt_at <= now())
        and (a.lease_until is null or a.lease_until <= now())
        and a.attempts < 5
      order by a.created_at
      limit p_limit
      for update skip locked
    )
    update public.alert_notifications a
       set lease_owner = p_worker, lease_until = now() + make_interval(secs => p_lease_seconds)
      from due where a.id = due.id
      returning a.id;
end $$;
revoke all on function private.claim_alert_notifications(text, int, int) from public, anon, authenticated;
grant execute on function private.claim_alert_notifications(text, int, int) to service_role;

-- Record one attempt outcome, fenced on the live lease. Success advances pending->sent via the
-- rank rule. Failure increments attempts, sets 2^attempts-minute backoff, and the 5th failure
-- terminates as 'failed' (operator-visible, contract REV 14). Returns the resulting state.
create or replace function private.mark_alert_attempt(p_id uuid, p_worker text, p_ok boolean)
returns text language plpgsql security definer set search_path = ''
as $$
declare v_attempts int; v_state text;
begin
  update public.alert_notifications a
     set attempts = a.attempts + 1,
         lease_owner = null, lease_until = null,
         state = case when p_ok then 'sent'
                      when a.attempts + 1 >= 5 then 'failed'
                      else 'pending' end,
         next_attempt_at = case when p_ok or a.attempts + 1 >= 5 then null
                                else now() + make_interval(mins => power(2, a.attempts)::int) end -- pre-increment attempts: 1st failure -> 1m, then 2/4/8/16 (REV 14)
   where a.id = p_id
     and a.lease_owner = p_worker and a.lease_until > now()
     and a.state = 'pending'
  returning a.attempts, a.state into v_attempts, v_state;
  if not found then
    raise exception 'MNZ:CONFLICT: alert notification not claimed by this worker or not pending';
  end if;
  return v_state;
end $$;
revoke all on function private.mark_alert_attempt(uuid, text, boolean) from public, anon, authenticated;
grant execute on function private.mark_alert_attempt(uuid, text, boolean) to service_role;

-- Public service_role wrappers (0003 pattern: PostgREST reaches public only).
create or replace function public.claim_alert_notifications(p_worker text, p_limit int, p_lease_seconds int)
returns setof uuid language sql security definer set search_path = '' as $$
  select private.claim_alert_notifications(p_worker, p_limit, p_lease_seconds);
$$;
revoke all on function public.claim_alert_notifications(text, int, int) from public, anon, authenticated;
grant execute on function public.claim_alert_notifications(text, int, int) to service_role;

create or replace function public.mark_alert_attempt(p_id uuid, p_worker text, p_ok boolean)
returns text language sql security definer set search_path = '' as $$
  select private.mark_alert_attempt(p_id, p_worker, p_ok);
$$;
revoke all on function public.mark_alert_attempt(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.mark_alert_attempt(uuid, text, boolean) to service_role;
