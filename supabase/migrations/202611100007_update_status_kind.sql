-- 202611100007_update_status_kind.sql REV 1 (contract owner)
-- Contract REV 12 (schemaVersion 2): admit the update.status telemetry kind.
-- The envelope/validation changes live in src/domain/telemetry.ts; this widens the
-- storage-level CHECK on public.technical_events so accepted v2 events persist. No other table change:
-- payload is jsonb, dedupe/clock rules are generic.
alter table public.technical_events drop constraint technical_events_kind_check;
alter table public.technical_events add constraint technical_events_kind_check
  check (kind in ('session.started', 'session.connected', 'session.ended', 'connection.failed', 'policy.ack', 'diagnostic.snapshot', 'update.status'));
