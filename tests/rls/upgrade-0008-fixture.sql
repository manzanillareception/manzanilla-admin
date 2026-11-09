-- Upgrade fixture for 0008 rev7: a database that already suffered the pre-index race carries
-- TWO active incidents with one fingerprint, plus links, alerts, a repair request and an audit
-- row. Applied after 0001..0007, before 0008. Assertions live in upgrade-0008-assert.sql.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'upg-admin@test.invalid');
insert into public.admin_members (user_id, enabled) values
  ('00000000-0000-0000-0000-0000000000a1', true);
insert into public.hotels (id, name, city) values
  ('00000000-0000-0000-0000-0000000000b1', 'Upgrade Hotel', 'Seville');
insert into public.devices (id, hotel_id, code, label, build) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000b1', 'UPG-1', 'tablet one', '9.9.9'),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000b1', 'UPG-2', 'tablet two', '9.9.9');

-- The two race-created incidents: A is the older survivor (earliest first_seen_at), B the loser.
insert into public.incidents (id, reference, fingerprint, error_code, component, severity, build, fix_class, occurrences, first_seen_at, last_seen_at, due_at)
values
  ('00000000-0000-0000-0000-0000000000e1', 'INC-501', 'MIC_PERMISSION_DENIED|android|9.9.9', 'MIC_PERMISSION_DENIED', 'android', 'medium', '9.9.9', 'hotel_action', 2,
     '2026-11-09 10:00:00+00', '2026-11-09 11:00:00+00', '2026-11-09 14:00:00+00'),
  ('00000000-0000-0000-0000-0000000000e2', 'INC-502', 'MIC_PERMISSION_DENIED|android|9.9.9', 'MIC_PERMISSION_DENIED', 'android', 'high', '9.9.9', 'hotel_action', 3,
     '2026-11-09 10:30:00+00', '2026-11-09 12:00:00+00', '2026-11-09 13:00:00+00');

-- Device links across both, including a duplicated pair that must collapse.
insert into public.incident_devices (incident_id, device_id) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000d1'),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000d1'),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000d2');

-- Alerts: r1 pending on both (survivor's earlier pending must win); r2 sent on the LOSER and
-- pending on the survivor (the sent terminal state must win even though it sits on the loser).
insert into public.alert_notifications (incident_id, recipient, state, attempts, created_at) values
  ('00000000-0000-0000-0000-0000000000e1', 'r1@example.com', 'pending', 0, '2026-11-09 10:00:05+00'),
  ('00000000-0000-0000-0000-0000000000e2', 'r1@example.com', 'pending', 1, '2026-11-09 10:30:05+00'),
  ('00000000-0000-0000-0000-0000000000e1', 'r2@example.com', 'pending', 0, '2026-11-09 10:00:05+00'),
  ('00000000-0000-0000-0000-0000000000e2', 'r2@example.com', 'sent', 1, '2026-11-09 10:30:05+00');

insert into public.repair_requests (incident_id, requested_by, target)
  values ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000a1', 'manual_runbook');
insert into public.admin_audit (actor_id, incident_id, action, reason)
  values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000e2', 'incident_triaged', 'upgrade fixture audit row');
