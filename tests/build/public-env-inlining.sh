#!/usr/bin/env bash
# Browser-bundle inlining proof for getPublicSupabaseEnv (dashboard production blocker).
# A unit test cannot catch a Next.js compilation/inlining issue: this builds the app with
# sentinel values and greps the EMITTED client chunks. The browser client module has no
# importer until the dashboard lane's auth pages integrate, so the script builds with a
# TEMPORARY client probe page that uses it (removed afterwards, never committed). Asserts:
#   1. the sentinel public URL and anon key ARE inlined into .next/static (client bundle)
#   2. the sentinel service-role key NEVER appears in .next/static (no secret leak)
set -euo pipefail
cd "$(dirname "$0")/../.."
PUB_URL_SENTINEL="public-sentinel-9f3e2a.example.test"
PUB_ANON_SENTINEL="public-anon-sentinel-7c1d"
SECRET_SENTINEL="service-role-secret-sentinel-b844"

probe_dir="src/app/env-probe-9f3e2a"
[ ! -e "$probe_dir" ] || { echo "FAIL: $probe_dir already exists; refusing to clobber"; exit 1; }
trap 'rm -rf "$probe_dir" .next/types' EXIT
mkdir -p "$probe_dir"
cat > "$probe_dir/page.tsx" <<'TSX'
'use client';
import { createClient } from '../../lib/supabase/browser';
export default function EnvProbe() {
  const client = createClient();
  return <div data-probe>{client ? 'configured' : 'unconfigured'}</div>;
}
TSX

NEXT_PUBLIC_SUPABASE_URL="https://${PUB_URL_SENTINEL}" \
NEXT_PUBLIC_SUPABASE_ANON_KEY="${PUB_ANON_SENTINEL}" \
SUPABASE_SERVICE_ROLE_KEY="${SECRET_SENTINEL}" \
  npx next build > /tmp/public-env-inlining-build.log 2>&1 || {
    echo "FAIL: next build errored"; tail -30 /tmp/public-env-inlining-build.log; exit 1; }

grep -rqs "${PUB_URL_SENTINEL}" .next/static \
  || { echo "FAIL: NEXT_PUBLIC_SUPABASE_URL was NOT inlined into the browser bundle"; exit 1; }
grep -rqs "${PUB_ANON_SENTINEL}" .next/static \
  || { echo "FAIL: NEXT_PUBLIC_SUPABASE_ANON_KEY was NOT inlined into the browser bundle"; exit 1; }
if grep -rqs "${SECRET_SENTINEL}" .next/static; then
  echo "FAIL: service-role sentinel LEAKED into the browser bundle"; exit 1
fi
echo "PUBLIC ENV INLINING OK: public url+anon inlined in client chunks; service-role sentinel absent"
