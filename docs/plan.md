# Four delivery phases

| Phase | Build | Exit condition |
|---|---|---|
| 1 — Local foundation, now | Separate repo/folder; four-tab mockup; typed state and metrics; privacy validation; repair briefs; CI definition | Demo actions work, tests/build pass, source reviewable; no old-repo or external changes |
| 2 — Secure backend | New user-owned accounts; Vercel + EU-region Supabase; named admin login/MFA; server-only API; transactional policy/audit; retention jobs; rate limits | Unauthorized/disabled admins denied; cross-device scope tested; production never serves demo data; SQL/RLS tested in real Postgres |
| 3 — One hotel pilot | Android enrollment/policy/telemetry integration against the forthcoming source version identified by the user; server session admission; provider adapters; alert delivery and independent watchdog | Online/offline approval and block races verified; direct audio remains fast; no content reaches telemetry; stop uncertainty remains visible |
| 4 — Repair and rollout | Sanitized intake; isolated Codex worker; reproduction and regression tests; draft PR; review; canary; recovery checks | A deliberately injected code defect is detected, reproduced, reviewed, rolled out and confirmed recovered without leaking secrets/content |

## Start here

Review the four tabs and metric meanings with synthetic records. Agree what constitutes a critical failure and who receives it. Do not start by building email onboarding, a hotel-facing dashboard, a complex queue or unrestricted auto-fixing.

## Connections later

The user will supply the new GitHub identity/repository, Vercel account, company email and domains later. Keep their credentials out of the ZIP/repository and use hosting secret stores. Configure a private repo with required CI checks and branch protection before connecting a repair worker. Domain and email verification are separate tasks.

The hotel onboarding design remains a later feature: a provisioned hotel account can use its generated password and optionally change it. Do not introduce a forced first-use reset from the reference images. Device enrollment and scoped credentials remain separate from a shared hotel password.

## `/goal` handoff for the next phase

```text
/goal Implement phase 2 in the new manzanilla-admin project only, after the user connects the new accounts. Preserve exactly Devices, Feature usage, Traffic and Failures. Replace the demo repository with explicit authenticated server adapters; never fall back to demo on production failure. Use named enabled internal admins, server-side authorization, Supabase Postgres transactions, RLS and content-free schema validation. Keep access, credential, connectivity, ACK and provider-stop states separate. Apply the migration only to a disposable test project first; prove anon/non-admin isolation and disabled-admin denial. Test stale revisions, duplicate and late events, blocked session admission, audit atomicity, retention and secret non-exposure. No Android repository change, real email, provider call, domain change, deployment or auto-merge unless separately authorized. Deliver a reviewable branch and test evidence; report missing capabilities honestly.
```

## Latest APK integration instruction — 9 November 2026

The user has asked us to make the Android-side changes when they push the new Manzanilla app source. Hotel email/password sign-in alone does not provide monitoring. Integrate per-installation enrollment, access policy/ACK, fresh heartbeat presence and content-free feature/traffic/failure reporting against the real backend once that version is available. This is recorded for the next app integration, not an active push watcher. See [the APK handoff](apk-integration-handoff.md).
