-- Triage RPC (dashboard lane read/triage gap, contract rev9).
-- POST /admin/incidents/:incidentId/triage calls this. Same conventions as 0004:
-- security definer, service_role only, MNZ:<CODE>:<message> errors.
-- The dashboard READ route (GET /api/v1/admin/dashboard) needs no SQL here: it reads
-- public control-foundation tables as service_role and assembles the Snapshot payload
-- server-side. Provisioning state for admins stays on public.provisioning_job_status
-- (0001 rev3), separate from the v1 snapshot payload.
begin;

-- Reason bound alignment (backend regression: accepted 500-char reason silently truncated
-- to 240). The column now stores the full contract-bounded reason (1..500); validation stays
-- at the route (contract section 3) and this check - never silent truncation.
alter table public.admin_audit drop constraint admin_audit_reason_check;
alter table public.admin_audit add constraint admin_audit_reason_check
  check (length(reason) between 1 and 500);

create or replace function public.control_triage_incident(
  p_actor uuid, p_incident_id uuid, p_note text default null)
returns table (incident_id uuid, status text)
language plpgsql security definer set search_path = ''
as $$
declare
  v_status text;
begin
  perform private.require_enabled_admin(p_actor);
  select i.status into v_status from public.incidents i where i.id = p_incident_id for update;
  if v_status is null then
    raise exception 'MNZ:NOT_FOUND: unknown incident';
  end if;
  if v_status in ('repair_requested', 'resolved') then
    raise exception 'MNZ:INVALID_STATE: incident is %, triage applies to open incidents', v_status;
  end if;
  if v_status = 'open' then
    update public.incidents set status = 'triaged' where incidents.id = p_incident_id;
    insert into public.admin_audit (actor_id, incident_id, action, reason)
    values (p_actor, p_incident_id, 'incident_triaged', coalesce(nullif(p_note, ''), 'triaged'));
  end if;
  -- Already triaged: idempotent no-op, returns the recorded state without a second audit row.
  return query select p_incident_id, 'triaged'::text;
end $$;
revoke all on function public.control_triage_incident(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.control_triage_incident(uuid, uuid, text) to service_role;

commit;
