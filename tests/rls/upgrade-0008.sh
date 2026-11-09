#!/usr/bin/env bash
# Upgrade test for 0008 rev7: apply the chain only up to 0007, inject the race-duplicated
#fixture, then apply 0008 (which must heal the duplicates transactionally and build the index)
# and assert the merge. Requires a DISPOSABLE database.
#   PGURL=postgres://postgres:postgres@localhost:54329/disposable tests/rls/upgrade-0008.sh
set -euo pipefail
: "${PGURL:?set PGURL to a DISPOSABLE database}"
here="$(cd "$(dirname "$0")" && pwd)"
mig="$(cd "$here/../.." && pwd)/supabase/migrations"

psql "$PGURL" -v ON_ERROR_STOP=1 -q -f "$here/stubs.sql"
for f in "$mig"/202611090001_control_foundation.sql \
         "$mig"/202611100001_email_provisioning.sql \
         "$mig"/202611100002_device_setup_tokens.sql \
         "$mig"/202611100003_rpc_wrappers_and_refs.sql \
         "$mig"/202611100004_control_rpcs.sql \
         "$mig"/202611100005_email_rpcs.sql \
         "$mig"/202611100006_triage_rpc.sql \
         "$mig"/202611100007_update_status_kind.sql; do
  echo "== applying $(basename "$f")"
  psql "$PGURL" -v ON_ERROR_STOP=1 -q -f "$f"
done
echo "== injecting race-duplicated fixture"
psql "$PGURL" -v ON_ERROR_STOP=1 -q -f "$here/upgrade-0008-fixture.sql"
echo "== applying 0008 (dedupe + index)"
psql "$PGURL" -v ON_ERROR_STOP=1 -q -f "$mig"/202611100008_incident_derivation.sql
echo "== asserting merge"
psql "$PGURL" -v ON_ERROR_STOP=1 -q -f "$here/upgrade-0008-assert.sql"
echo "UPGRADE 0008 CHAIN COMPLETE: duplicates healed, index built, post-merge ingest green."
