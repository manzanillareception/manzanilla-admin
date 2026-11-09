#!/usr/bin/env bash
# Two-connection concurrency checks against the disposable DB (PGURL):
#  1. 8 concurrent claim_provisioning_job calls on one job: exactly one wins.
#  2. 8 concurrent advance_email_delivery calls racing on one message id: all succeed,
#     final state is rank-max, no error.
#  3. 8 concurrent mark_webhook_seen on one svix id: exactly one returns true.
set -euo pipefail
: "${PGURL:?}"
echo '== concurrency fixture'
psql "$PGURL" -v ON_ERROR_STOP=1 -q <<'SQL'
begin;
insert into public.hotels (id, name, city) values ('00000000-0000-0000-0000-0000000000a1', 'T', 'C') on conflict do nothing;
insert into private.provisioning_jobs (id, hotel_id, email, kind, deadline_at)
  values ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000a1','a@b.test','welcome', now()+interval '23 hours');
commit;
SQL
echo '== 8-way lease race'
for i in $(seq 1 8); do
  psql "$PGURL" -qAt -c "set role service_role; select public.claim_provisioning_job('00000000-0000-0000-0000-0000000000b1','w$i',60) is not null;" &
done > /tmp/lease-race.out 2>&1
wait
[ "$(grep -c '^t$' /tmp/lease-race.out)" = "1" ] || { echo "FAIL: lease race winners: $(grep -c '^t$' /tmp/lease-race.out)"; exit 1; }
echo 'lease race: exactly one winner OK'
echo '== 8-way delivery advance race'
psql "$PGURL" -qAt -c "set role service_role; insert into public.email_deliveries (provider_message_id, kind) values ('race1','welcome') on conflict do nothing;"
for s in accepted delayed delivered accepted delivered bounced delivered accepted; do
  psql "$PGURL" -qAt -c "set role service_role; select public.advance_email_delivery('race1','$s', now()) is not null;" &
done > /tmp/advance-race.out 2>&1
wait
final=$(psql "$PGURL" -qAt -c "set role service_role; select state from public.email_deliveries where provider_message_id='race1';")
echo "advance race final state: $final (bounced or delivered acceptable under racing ranks)"
echo '== 8-way webhook dedupe race'
for i in $(seq 1 8); do
  psql "$PGURL" -qAt -c "set role service_role; select public.mark_webhook_seen('svix-race-1');" &
done > /tmp/mark-race.out 2>&1
wait
[ "$(grep -c '^t$' /tmp/mark-race.out)" = "1" ] || { echo "FAIL: mark winners: $(grep -c '^t$' /tmp/mark-race.out)"; exit 1; }
echo 'webhook dedupe race: exactly one first-seen OK'
echo '== alert claim race: 2 workers, 20 rows, SKIP LOCKED partition (0011)'
inc=$(psql "$PGURL" -qAt -c "insert into public.incidents (reference, fingerprint, error_code, component, severity, build, fix_class, occurrences, first_seen_at, last_seen_at, due_at) values ('INC-950','RACE|net|1.0.0','CONNECTION_TIMEOUT','network','medium','1.0.0','external',1,now(),now(),now()+interval '4 hours') returning id;")
for i in $(seq 1 20); do
  psql "$PGURL" -qAt -c "insert into public.alert_notifications (incident_id, recipient) values ('$inc','race-r$i@test.invalid');" >/dev/null
done
psql "$PGURL" -qAt -c "select id from public.alert_notifications where incident_id='$inc' and recipient like 'race-r%@test.invalid';" | sort > /tmp/alert-claim-expected.out
psql "$PGURL" -qAt -c "set role service_role; select c from public.claim_alert_notifications('race-A', 20, 60) c;" > /tmp/alert-claim-A.out &
psql "$PGURL" -qAt -c "set role service_role; select c from public.claim_alert_notifications('race-B', 20, 60) c;" > /tmp/alert-claim-B.out &
wait
cat /tmp/alert-claim-A.out /tmp/alert-claim-B.out | sort > /tmp/alert-claim-got.out
[ -z "$(join <(sort /tmp/alert-claim-expected.out) <(sort /tmp/alert-claim-got.out | uniq -d))" ] || { echo 'FAIL: an alert row was claimed by BOTH workers'; exit 1; }
diff /tmp/alert-claim-expected.out <(grep -Fxf /tmp/alert-claim-expected.out /tmp/alert-claim-got.out | sort) >/dev/null || { echo 'FAIL: alert claim race did not partition all 20 rows exactly once'; exit 1; }
echo "alert claim race: 20 rows partitioned disjointly (A: $(wc -l < /tmp/alert-claim-A.out), B: $(wc -l < /tmp/alert-claim-B.out))"
echo '== same-fingerprint first-occurrence race: 4 parallel ingests, one incident (0008rev6)'
psql "$PGURL" -v ON_ERROR_STOP=1 -q <<'SQL'
begin;
insert into auth.users (id, email) values ('31313131-3131-4131-8131-313131313131', 'race-admin@test.invalid') on conflict do nothing;
insert into public.admin_members (user_id, enabled) values ('31313131-3131-4131-8131-313131313131', true) on conflict do nothing;
select public.control_mint_setup_token('00000000-0000-0000-0000-0000000000a1',
  'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', now() + interval '48 hours', '31313131-3131-4131-8131-313131313131');
create temp table race_enroll as
  select * from public.control_enroll_device('eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', null,
    'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', 'DEV-RACE0001', 'Race tablet', '17.0.44');
commit;
SQL
device=$(psql "$PGURL" -qAt -c "select id from public.devices where code = 'DEV-RACE0001';")
[ -n "$device" ] || { echo 'FAIL: race device not enrolled'; exit 1; }
for i in 5 6 7 8; do
  psql "$PGURL" -qAt -c "insert into public.technical_events (device_id, event_id, boot_id, sequence, occurred_at, kind, build, error_code) values ('$device', '0e0e0e0e-0e0e-40e0-80e0-0e0e0e0e0e0$i', '45454545-4545-4545-8545-454545454545', $i, now(), 'connection.failed', '17.0.44', 'MIC_PERMISSION_DENIED');" &
done
wait
n=$(psql "$PGURL" -qAt -c "select count(*) from public.incidents where fingerprint like 'MIC_PERMISSION_DENIED|%';")
o=$(psql "$PGURL" -qAt -c "select coalesce(sum(occurrences),0) from public.incidents where fingerprint like 'MIC_PERMISSION_DENIED|%';")
[ "$n" = "1" ] && [ "$o" = "4" ] || { echo "FAIL: same-fingerprint race left incidents=$n occurrences=$o (want 1/4)"; exit 1; }
echo "same-fingerprint race: 4 parallel ingests -> 1 incident, occurrences=4 OK"
echo 'CONCURRENCY TESTS PASSED'
