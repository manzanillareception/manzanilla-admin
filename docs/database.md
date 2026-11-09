# Database foundation

`supabase/migrations/202611090001_control_foundation.sql` is an **unapplied Supabase/Postgres migration**. It is not connected to the demo and has not been executed or role-tested against a real database in this task. Do not apply it to the old app's database.

The foundation separates hotels, named internal admin membership, devices, credential hashes, logical voice sessions, connection attempts, content-free events, traffic buckets, grouped incidents, repair requests and admin audit. Demo string IDs map to generated database UUIDs in a future repository adapter. Provider session handles are server-only; never include them in dashboard exports.

RLS is enabled on every table. Anonymous clients have no grants. Enabled named admins can read permitted operational records through an explicit membership predicate; non-admin hotel users and devices cannot read those tables. Credential hashes are server-only. Authenticated clients have no mutation grants. Phase 2 implements authenticated server mutation handlers and transactionally appends audit/policy changes. The service role bypasses RLS, so the server must authorize every request itself; RLS does not rescue a careless service-role endpoint.

## Before a connected pilot

- Create a disposable Supabase project. Apply once with the project migration tool and run real Postgres/pgTAP tests.
- Test anonymous, hotel-authenticated, disabled-admin, enabled-admin and service-role sessions. Include credential-table denial and cross-device event/session constraints.
- Bootstrap the first named admin by trusted migration/SQL after creating its Auth identity. There is no public admin signup or browser-controlled role field. Require MFA for internal admins.
- Implement short transactional policy/ACK mutations with expected revisions, idempotency keys and audit. This migration defines records/constraints, not all business RPCs.
- Implement event ingestion deduplication and monotonic session finalization before deriving analytics. Historical ingest must not freshen heartbeat state.
- Implement retention/deletion jobs, backups, restoration and restore authorization tests. Proposed 30/90/180-day retention is a product decision pending review; no purge job runs here.
- Keep service-role keys in server hosting secrets. No `NEXT_PUBLIC_` service-role or provider key.
- Verify provider token/call creation and cancellation with actual accounts before managed Android admission. The SQL is not proof that remote audio can be stopped.

No production adapter is implemented. Do not expose a public write endpoint by wiring the demo store to this database.
