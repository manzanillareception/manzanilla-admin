#!/usr/bin/env bash
# Usage: PGURL=postgres://user@localhost/disposable tests/email/db/run.sh
# Disposable DB only. Applies stubs, baseline, 001..003, then the assertions.
set -euo pipefail
: "${PGURL:?set PGURL to a DISPOSABLE database}"
here="$(cd "$(dirname "$0")" && pwd)"; root="$here/../../.."
psql "$PGURL" -v ON_ERROR_STOP=1 -q -f "$here/stubs.sql"
for f in "$root"/supabase/migrations/*.sql; do psql "$PGURL" -v ON_ERROR_STOP=1 -q -f "$f"; done
psql "$PGURL" -v ON_ERROR_STOP=1 -q -f "$here/email_provisioning.test.sql"
