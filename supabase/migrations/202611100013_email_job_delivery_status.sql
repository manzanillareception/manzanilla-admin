-- Project authenticated delivery outcomes onto jobs in the SAME transaction as
-- the monotonic email_deliveries advance. Replay cannot downgrade delivery state.
begin;
create or replace function private.sync_provisioning_delivery()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.job_id is null or new.state not in ('delivered','bounced','complained','failed') then return new; end if;
  update private.provisioning_jobs
     set status = case when new.state = 'delivered' then 'done' else 'needs_attention' end,
         last_error = case when new.state = 'delivered' then null else 'email_' || new.state end,
         sealed_password = null,
         provider_message_id = new.provider_message_id,
         lease_owner = null, lease_until = null, updated_at = clock_timestamp()
   where id = new.job_id
     -- An older message must not finalize a newer retry of the same job.
     and (provider_message_id = new.provider_message_id or provider_message_id is null)
     and (new.state <> 'delivered' or status <> 'needs_attention');
  return new;
end $$;
revoke all on function private.sync_provisioning_delivery() from public, anon, authenticated;
drop trigger if exists sync_provisioning_delivery on public.email_deliveries;
create trigger sync_provisioning_delivery after insert or update of state on public.email_deliveries
  for each row execute function private.sync_provisioning_delivery();
-- Repair previously recorded outcomes without rewriting any delivery histories.
update public.email_deliveries e set state = e.state
 where e.state in ('delivered','bounced','complained','failed')
   and exists (select 1 from private.provisioning_jobs j
               where j.id = e.job_id and j.provider_message_id = e.provider_message_id);
commit;
