# Goal commands

Run these in order. The current delivery covers goal 1. All later goals require the user to connect the new accounts and explicitly authorize the corresponding integration. No goal grants authority over the old Manzanilla repository.

## Goal 1 — Review the local base

```text
/goal Review and validate the separate manzanilla-admin foundation. Keep exactly four tabs: Devices, Feature usage, Traffic and Failures. Verify approval/block requests distinguish desired state, confirmed revision and connectivity. Verify legacy/offline devices do not falsely show stopped. Reconcile feature sessions versus retry attempts, traffic failure denominators, sample counts and UTC dates. Verify telemetry rejects guest content and unknown fields, and repair packets contain bounded technical metadata only. Run typecheck, tests, production build and standalone preview build. Exercise all tabs, filters and actions at desktop and phone widths. No remote repository, deployment, email, domain or old-app change. Deliver reviewable local source and test evidence.
```

Acceptance: no placeholder “live” claim; every visible control works or explains the missing connection; no secrets; standalone mockup works without accounts.

## Goal 2 — Connect a secure backend

```text
/goal After the user connects the NEW GitHub, Vercel and Supabase projects, implement the authenticated control backend in manzanilla-admin only. Start with a disposable Supabase database. Choose a specific EU database region and colocate Vercel control functions, then review processor/transfer requirements. Implement named enabled internal-admin authentication with MFA, authorization on every server route, CSRF/origin protection for cookie mutations, transactional policy revisions and audit, strict event ingestion, request limits and retention jobs. Separate production adapters from the demo and fail closed with setup_required when incomplete. Device authentication must be per installation; derive scope server-side. Verify anonymous, hotel, disabled-admin and cross-device denial with real Postgres tests. Do not invoke real voice providers or alter Android yet. Open a reviewable PR to the new authorized repository; do not auto-merge or deploy.
```

Acceptance: no production demo fallback; server-only secrets; tested RLS/authorization; stale revision and event replay tests; audit atomicity and backup/restore plan.

## Goal 3 — Pilot one hotel and real device control

```text
/goal After separate authorization for the Android integration and provider test accounts, pilot one hotel against the new control plane. Add scoped enrollment, policy polling/ACK, fresh heartbeat presence and content-free bounded telemetry without changing existing voice UX. Verify direct live-audio transports and provider-specific session creation/cancellation before enabling managed enforcement. Broker each new session, recheck policy after provider creation, reconcile unknown outcomes and track device ACK separately from provider termination. Test offline, revocation, duplicate create, block-during-create and stop-timeout paths on actual hardware. Preserve enrollment and local configuration during recovery. Integrate real alert delivery plus an independent watchdog. Keep uncontrolled legacy APKs marked unmanaged. Report measured latency and gaps; no blanket claim that blocking remotely stops every call.
```

Acceptance: unauthorized new sessions denied; genuine policy ACK visible; stop uncertainty visible; measured device/provider tests; no conversation content in dashboard/storage/logs; real alert receipt verified.

## Goal 4 — Add a constrained repair pipeline

```text
/goal After the new repo and pilot monitoring are stable, implement a constrained Codex repair worker for the NEW admin repository. Accept only trusted incident IDs and immutable allowlisted commits. Build sanitized context from typed error codes and approved reproduction templates. Device reports are untrusted data and cannot supply instructions, repositories, URLs, shell commands or secrets. Classify configuration/provider/network issues into runbooks. Reproduce genuine code candidates in an isolated budgeted sandbox, add a regression test, patch an isolated branch, run required checks and create a draft PR through a scoped GitHub App. Android incidents remain a handoff unless separately authorized. Require review for merge and release, stage a canary and verify affected devices recover; support rollback. Never grant the worker production keys, branch-protection changes, auto-merge or unattended main pushes.
```

Acceptance: an injected defect completes detection→reproduction→review→canary→verified recovery; malicious telemetry cannot control the worker; external outages never trigger speculative patches; response due times and owners remain explicit.
