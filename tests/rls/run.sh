#!/usr/bin/env bash
# Disposable-Postgres test chain for the /api/v1 control plane.
# Usage:
#   PGURL=postgres://postgres:postgres@localhost:55432/disposable \
#   MIGRATIONS_DIR=/path/to/migrations tests/rls/run.sh
#
# MIGRATIONS_DIR must hold the baseline (from this repo, supabase/migrations/) plus the
# contract owner's migration artifacts (0001..0005) which are NOT committed by lanes.
# EMAIL_TEST_SQL optionally points at the email lane's db test file.
# Never run against a non-disposable database.
set -euo pipefail
: "${PGURL:?set PGURL to a DISPOSABLE database}"
: "${MIGRATIONS_DIR:?set MIGRATIONS_DIR to the migration chain directory}"
here="$(cd "$(dirname "$0")" && pwd)"

psql "$PGURL" -v ON_ERROR_STOP=1 -q -f "$here/stubs.sql"
for f in "$MIGRATIONS_DIR"/*.sql; do
  echo "== applying $(basename "$f")"
  psql "$PGURL" -v ON_ERROR_STOP=1 -q -f "$f"
done
if [ -n "${EMAIL_TEST_SQL:-}" ]; then
  echo "== email lane db tests"
  psql "$PGURL" -v ON_ERROR_STOP=1 -q -f "$EMAIL_TEST_SQL"
fi
echo "== backend rls/rpc tests"
psql "$PGURL" -v ON_ERROR_STOP=1 -q -f "$here/backend.test.sql"
echo "CHAIN COMPLETE: migrations applied, verified sections and retained regressions green."
