# Manzanilla /api/v1 contract — FROZEN v1

Status: FROZEN, version 1, 2026-11-10 (Asia/Calcutta).
REV 13 (2026-11-10, Asia/Calcutta): ONE additive Snapshot key ratified - `devices[].update` (see §3/§10). Snapshot schemaVersion stays 1; all other unknown keys remain hard-rejected.
REV 14 (2026-11-10, Asia/Calcutta): alert delivery policy pinned. `alert_notifications` rows are created on NEW incidents of EVERY severity (spec lines 91/133), one deduplicated row per (incident, recipient). Send attempts: max 5; failure backoff 2^attempts minutes (1,2,4,8,16) via `next_attempt_at`; the 5th failure marks the row `failed` (terminal, operator-visible; never silently dropped). `sent` means provider-accepted, never read. Rank-ordered state advance unchanged (pending0<sent1<delivered2<bounced/failed3); a higher state never regresses. Worker claims are lease-fenced (0011) so concurrent workers never double-send; webhook advances use the existing rank RPC. Real provider sends stay externally gated; local runs use the capture adapter.

REV 12 clarification (2026-11-10, for the Android module): `update.status.feedId` is the STABLE identity of the update feed the device follows (e.g. the feed URL or channel name), never the discovered release tag - the discovered build belongs in `discoveredVersion`. `publishedAt` is the release's actual publish timestamp from the feed metadata; the device parser must capture it where the feed provides it, and only sends null when the feed genuinely omits it. `currentBuild` is the build currently running on the device.
REV 12 (2026-11-10, Asia/Calcutta): ratifies the FIRST schemaVersion 2 addition - the `update.status` event kind (spec line 122's "actually reported update status" is an explicit original requirement, not deferrable). v1 clients and the v1 six-kind envelope are unchanged and remain accepted; see §4/§5. Requires migration `202611100007` (widens the `public.technical_events.kind` CHECK); dedupe/clock-window rules are generic and needed no change.
Canonical schemas: `src/domain/telemetry.ts`, `src/domain/types.ts`, and `supabase/migrations/**`.
Basis: derived from `manzanilla-admin` commit `5fe9a7e` (`docs/device-contract.md`, `docs/database.md`, `src/domain/telemetry.ts`) and the owner's V2 handoff. Where any other repo doc conflicts, this file wins.
Applies to: backend, email, dashboard (repo `manzanillareception/manzanilla-admin`) and Android (repo `manzanillareception/manzanilla`).

## 0. Change process

- v1 is frozen: the six telemetry event kinds, their exact fields/bounds, the envelope rules, and the route set below do not change.
- A new event kind, a new field, or a relaxed bound is a BREAKING change (envelope parsing is strict; unknown fields are rejected). It requires `schemaVersion: 2` and coordinated backend + Android + dashboard rollout, approved through the maintainer before any code.
- Clarifications that do not change wire behavior may be appended to §10 by the maintainer only.
- REV 12: schemaVersion 2 is ratified for exactly one additive kind, `update.status`. Servers MUST accept both envelope versions indefinitely; a v2 envelope may carry any v1 kind plus `update.status`; devices emitting only the six v1 kinds keep `schemaVersion: 1`. All other v2 changes still require the §0 process.
- Schema changes are never coded directly. A module files a migration request (exact columns, constraints, rationale) to the maintainer, who authors the SQL. See §9.

## 1. Identities and scope

- Two identity classes: **internal admin** (Supabase Auth user, named row in `public.admin_members`, `enabled = true`, MFA required) and **device installation** (high-entropy credential returned once at enrollment, only its SHA-256 hex hash stored in `private.device_credentials`).
- Scope is always derived from the authenticated credential. `hotelId`, `deviceId`, provider call IDs, or role claims inside any request JSON are untrusted and never used for authorization.
- Admin and device credentials are never interchangeable. No public admin signup, no browser-controlled role field.
- Device credentials: 32–4096 chars, no whitespace/control chars (matches Android `HotelConnection` validation). Reinstallation may require re-enrollment.

## 2. Route set (complete for v1)

Base path `/api/v1`. All bodies JSON. All error bodies use §8.

| Route | Auth | Responsibility |
|---|---|---|
| `POST /devices/enroll` | Hotel user session (Supabase JWT from hotel email/password sign-in) OR one-use setup token | Bind one installation to the authenticated hotel; return the device credential once; device starts `pending` |
| `POST /devices/heartbeat` | Device credential | Record server-observed fresh presence; return current policy state |
| `POST /events/batch` | Device credential | Ingest the §4 envelope; transactional dedupe; content-free only |
| `POST /devices/policy-ack` | Device credential | ACK a policy revision; distinct from provider termination |
| `POST /devices/sessions` | Device credential, `approved` required | Reserve logical session + capacity slot; admission decision only in v1 (provider connection data reserved, see §7) |
| `POST /admin/devices/:deviceId/policy` | Enabled admin | Optimistic revision advance + immutable audit |
| `POST /admin/incidents/:incidentId/repair` | Enabled admin | Build server-owned sanitized repair brief; never executes device text |
| `POST /admin/hotels` | Enabled admin | provision hotel (Auth user + one-use setup credential + welcome delivery state) |
| `POST /admin/hotels/:hotelId/recovery` | Enabled admin | resend credential recovery for a hotel |
| `POST /webhooks/resend` | Resend webhook signature | record delivery events (delivered/bounced/complained) idempotently |
| `GET /admin/dashboard` | Enabled admin | REV 9: read model for the fleet dashboard (Snapshot payload, cursor pagination) |
| `POST /admin/incidents/:incidentId/triage` | Enabled admin | REV 9: mark an open incident triaged + immutable audit |

These device and policy routes have production adapters. Missing configuration still returns 503 `SETUP_REQUIRED`, never demo data.

## 3. Request/response shapes (v1)

`Id` = UUID unless stated. Timestamps RFC 3339 with offset. Unknown fields rejected everywhere.

**POST /devices/enroll** (REV 6 - original user spec governs: one-time hotel email/password setup on the tablet, then per-installation enrollment)
Two credential paths. Send exactly one:
1. Hotel session (SPEC-REQUIRED primary): `Authorization: Bearer <hotel user Supabase JWT>` from hotel email/password sign-in. Server resolves `hotel_id` from `public.hotel_users` by `auth.uid()` - never from the request body. A hotel session may enroll installations for ITS OWN hotel only and has no fleet read access (RLS blocks all table reads; this route is the only hotel-reachable operation, executed server-side).
2. One-use setup token (admin-assisted installs): body `setupToken`, no session. Consumed atomically via `consume_setup_token`.
Request: `{ label: string(1..80), build: string(^[0-9]{1,4}(\.[0-9]{1,4}){0,3}$), bootId: uuid, setupToken?: string }`
Response 200: `{ deviceId: uuid, deviceCredential: string(32..4096), desiredAccess: "pending", policyRevision: 1 }`. The enrolled installation is a managed control-plane device (`managed = true`).
Approval stays independent: enrollment only creates a `pending` device; an enabled admin approves via the policy route. Errors: `VALIDATION_FAILED`, `UNAUTHORIZED` (no valid session and no token), `FORBIDDEN` (session is not a hotel user), `SETUP_TOKEN_INVALID`, `SETUP_TOKEN_CONSUMED`, `UNAVAILABLE`.

**POST /devices/heartbeat**
Headers: `Authorization: Bearer <deviceCredential>`
Request: `{ bootId: uuid, sequence: int(0..2^31-1), build: string, mode: "idle"|"translation"|"reception", microphone: "granted"|"denied"|"unknown", occurredAt: timestamp }`
Freshness: `(bootId, sequence)` must strictly advance per device; replays return 200 but never update `last_seen_at`. Server receipt time is the presence record, not `occurredAt`.
Response 200: `{ desiredAccess: Access, effectiveAccess: Access, policyRevision: int, serverTime: timestamp }`
Errors: `UNAUTHORIZED`, `CREDENTIAL_REVOKED`, `VALIDATION_FAILED`, `RATE_LIMITED` (retryable), `UNAVAILABLE` (retryable).

**POST /events/batch**
Headers: `Authorization: Bearer <deviceCredential>`
Request: the §4 envelope exactly.
Response 200: `{ accepted: int, duplicates: int }` (duplicates counted separately, never error; re-uploaded batches cannot inflate counters). Per-event schema failures reject the whole batch with `VALIDATION_FAILED`.
Blocked devices with valid credentials MAY send `policy.ack` and `diagnostic.snapshot` only; session kinds return `DEVICE_BLOCKED`. `update.status` (REV 12) is NOT in the blocked-allowed set: a blocked device reports `DEVICE_BLOCKED` for it; unblocking re-enables reporting. Revoked credentials: `CREDENTIAL_REVOKED`.

**POST /devices/policy-ack**
Request: `{ revision: int(>=1), bootId: uuid, sequence: int }`
Response 200: `{ acknowledged: true, revision: int }`. A stale revision ACK is recorded but never changes later state (`ack_revision` is monotonic).

**POST /devices/sessions**
Request: `{ sessionId: string(1..96, ^[A-Za-z0-9][A-Za-z0-9_-]*$), attemptId: string(same), feature: "translation"|"reception" }`
Response 200 admitted: `{ admit: true, policyRevision: int, provider: null }` — `provider` is reserved; v1 returns null and the app proceeds with its existing direct provider behavior (OpenAI device BYOK / bundled Cartesia). Denied: `{ admit: false, reason: "pending"|"blocked"|"unavailable", policyRevision: int }` with 200; the app must treat `admit:false` as a hard stop for new voice starts.
REV 9 (backend DB-test finding): the admission gate is `desired_access = 'approved'`, NOT `effective_access`. An admin block denies NEW sessions immediately at the server without waiting for the device ACK; an approval admits immediately. `effective_access` remains the device-ACKed view for display.
Idempotent on `(deviceId, sessionId, attemptId)`: a repeated attemptId returns the recorded decision; a NEW attemptId on an existing sessionId records the new attempt and returns the admission. A sessionId's `feature` is immutable: a mismatched feature (admission or `session.started` event) fails with `SESSION_FEATURE_MISMATCH`. An ENDED session never gains attempts: admission or a `session.started` event for an ended sessionId fails with `INVALID_STATE`.

**POST /admin/devices/:deviceId/policy**
Request: `{ expectedRevision: int, desiredAccess: "pending"|"approved"|"blocked", reason: string(1..500) }`
Response 200: `{ deviceId: uuid, revision: int, desiredAccess: Access, effectiveAccess: Access, recorded: boolean }`. `recorded` is true ONLY when the response is the historical recorded result of a retried operation (below); on a fresh change or same-state no-op it is false and the row reflects current state. `expectedRevision` mismatch → 409 `STALE_REVISION`. Repeated identical requests are idempotent. Every call appends one immutable `admin_audit` row in the same transaction.
REV 10/11 retry semantics: a retried request carries its ORIGINAL `expectedRevision` and original `reason`. When the current revision has moved on, the server returns the recorded result if and only if an audit row exists for the SAME actor, device, revision `expectedRevision + 1`, same desired state, and SAME reason - i.e. this exact operation already succeeded. That response carries `recorded: true` and the operation's HISTORICAL recorded revision, which may be behind the current revision; it is not a claim about current state (the dashboard refreshes after every mutation, so current state is always re-read). A stale edit by another actor, with a different desired state, or with a different reason is not a retry: it returns 409 `STALE_REVISION` so the client refreshes and resubmits against current state - a new rationale is never silently dropped as a retry. The audit reason is stored in full (column bound 500, matching the request bound); never silently truncated.

**POST /admin/incidents/:incidentId/repair**
Request: `{ target: "android_handoff"|"new_admin_repo"|"manual_runbook" }`
Response 200: `{ repairRequestId: uuid, state: "brief_ready" }`. Brief content is server-owned and allowlisted; no device-supplied strings, URLs, or commands.
Errors: `NOT_FOUND` (unknown incident), `INVALID_STATE` (incident already resolved).

**GET /admin/dashboard** (REV 9 - dashboard module read model; backend owns the route)
Query: `periodDays` (int, server-clamped to 1..90, default 30), `cursor` (opaque, from a previous response's `nextCursor`).
Response 200: the Snapshot payload (`schemaVersion: 1`) exactly as validated by the dashboard's `src/components/data/live-source.ts` strict zod schema - `asOf` (server-observed data time; presence classes are computed against it), `hotels`, `devices` (incl. `access.reason` = latest `policy_requested` admin_audit reason per device), `sessions`, `traffic`, `incidents` (titles/next steps from the server-owned allowlist, never device text), `policyHistory`, `repairRequests`, plus `nextCursor: string|null` (null or absent when the snapshot is complete). Assembled server-side as service_role from the control-foundation rows via the dashboard module's pure mapping `src/lib/queries/dashboard.ts`; the consumer rejects unknown fields, so the payload carries NO extra keys in v1 - per-hotel provisioning/delivery state stays on the separate `provisioning_job_status` admin read. REV 13 single exception: `devices[].update: null | { feedId, state: "up_to_date"|"update_available"|"downloading"|"downloaded"|"installing"|"installed"|"failed", currentBuild, discoveredVersion: string|null, publishedAt: timestamp|null, progressPct: int(0..100)|null, error: string|null, reportedAt: timestamp }` - OPTIONAL key, `null` (or absent) = no update.status ever reported, rendered honestly as "Not reported". Derived server-side from the latest accepted `update.status` per device (by occurredAt, tiebreak receivedAt); presence/heartbeat recency stays a separate signal, never folded in. The dashboard consumer validates this one key as optional+nullable; every other unknown key is still a hard reject. Errors: `UNAUTHORIZED`, `FORBIDDEN`/`MFA_SETUP_REQUIRED`, `VALIDATION_FAILED` (bad cursor), `RATE_LIMITED`, `UNAVAILABLE`, `SETUP_REQUIRED`.

**POST /admin/incidents/:incidentId/triage** (REV 9 - migration `202611100006`)
Request: `{ note?: string(1..500) }` (stored in full; absent note records 'triaged').
Response 200: `{ incidentId: uuid, status: "triaged" }`. Idempotent when already triaged (no second audit row). Errors: `NOT_FOUND`, `INVALID_STATE` (incident is `repair_requested` or `resolved`).

**Email module routes** (`/admin/hotels`, `/admin/hotels/:id/recovery`, `/webhooks/resend`): detailed body shapes are owned by the email module within these paths and this contract's identity/error rules. Welcome and recovery mail never contain provider keys or device credentials; the hotel portal password is set at provisioning, with no forced first-use reset. Webhook handler verifies the Resend signature, dedupes on the provider event ID, and stores delivery state server-side only.

## 4. Telemetry envelope (wire canonical)

Canonical schema: `telemetryEnvelopeSchema` in `src/domain/telemetry.ts` at commit `5fe9a7e`, reproduced here as the freeze:

- Envelope (REV 12): `z.strictObject({ schemaVersion: z.union([z.literal(1), z.literal(2)]), events: array(1..100) })`; serialized body ≤ 64 KiB. `schemaVersion: 1` = the six v1 kinds only. `schemaVersion: 2` = the six v1 kinds plus `update.status`; a v1-kind event inside a v2 envelope validates against the same v1 shape.
- Every event: `eventId: uuid, bootId: uuid, sequence: int(0..2^31-1), occurredAt: timestamp, build: ^[0-9]{1,4}(\.[0-9]{1,4}){0,3}$`.
- Session events add: `sessionId, attemptId (identifier ^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$), feature: "translation"|"reception"`. One `sessionId` never changes feature within a batch or across history.
- Kinds:
  - `session.started` — base session fields only.
  - `session.connected` — `firstAudioMs: int(0..120000) | null`.
  - `session.ended` — `durationMs: int(0..86400000), durationProvenance: "observed"|"estimated"`.
  - `connection.failed` — `code: "CONNECTION_TIMEOUT"|"MIC_PERMISSION_DENIED"|"PROVIDER_UNAVAILABLE"|"AUDIO_STARTUP_TIMEOUT"|"POLICY_SYNC_FAILED"`.
  - `policy.ack` — `revision: int(1..2^31-1)`.
  - `diagnostic.snapshot` — `microphone: "granted"|"denied"|"unknown", batteryPercent: int(0..100)|null, freeMemoryMb: int(0..1048576)|null`.
  - `update.status` (REV 12, schemaVersion 2 only) — strict payload: `feedId: string(1..200)` (the release feed the device polls, e.g. `"github:somdipto/manzanilla"`), `state: "up_to_date"|"update_available"|"downloading"|"downloaded"|"installing"|"installed"|"failed"`, `currentBuild: build-string` (same format as the event `build` field, the installed build), `discoveredVersion: string(1..100)|null`, `publishedAt: timestamp|null` (feed-side publish time of discoveredVersion), `progressPct: int(0..100)|null` (only meaningful for downloading/installing), `error: string(1..500)|null` (only for failed). Emission cadence: on every state CHANGE, and at most one `update.status` per heartbeat interval otherwise (no polling amplification); identical replay dedupes by eventId like every kind.
- Forbidden content (hard reject): audio, captions, transcripts, prompts, guest identities, room numbers, free-form messages, arbitrary JSON/metadata, provider response bodies, keys.

## 5. Ingestion rules (backend)

- Dedupe `(authenticated deviceId, eventId)` transactionally; accepted replays are `duplicates`, never re-applied.
- Clock window: reject events with `occurredAt` > server receive + 120 s or < receive − 30 days.
- Historical uploads never update `last_seen_at` and never reopen an ended session. Session/attempt end is monotonic.
- Batch limits: ≤ 100 events, ≤ 64 KiB, per-device rate limit with `RATE_LIMITED` + `retryAfterMs`; the device offline queue is capped (Android module).
- Every accepted batch that changes policy-relevant state appends audit in the same transaction. `update.status` never writes audit, never changes presence on its own (heartbeat recency remains the presence signal), and is stored like any other event; the device's current update state is DERIVED as the latest accepted `update.status` per device plus the `build` field and heartbeat recency (spec line 147 separation: built/published are feed-side facts, discovered/installed are `update.status` states, fresh post-update heartbeat is heartbeat recency after an `installed` event).

## 6. State separation (never conflate)

Distinct columns/states, all preserved: `desired_access` vs `effective_access`; `policy_revision` vs `ack_revision`; `credential_state` (valid/revoked); presence (`last_seen_at`, freshness class online/stale/offline/never-seen computed server-side); session state vs attempt outcome; duration provenance; provider termination (v1: not implemented, never claimed). Dashboard displays unknown/empty as unknown — never fabricated zeros or healthy-fleet synthesis.

## 7. Provider admission (v1 limits)

v1 session admission is a policy gate only. Authoritative remote provider enforcement is out of scope: OpenAI is device BYOK and Cartesia is a bundled key, so a server block cannot terminate in-flight provider sessions. The contract keeps the `provider` field reserved/null. No module may claim provider stop, invent a token API, or upload the OpenAI key. Distinguish always: app block / device ACK / provider confirmation.

## 8. Error envelope

All errors: `{ error: { code: string, message: string, retryable: boolean, retryAfterMs?: int } }`.
Codes: `VALIDATION_FAILED` (400), `UNAUTHORIZED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404, admin routes), `CREDENTIAL_REVOKED` (401), `DEVICE_BLOCKED` (403), `SETUP_TOKEN_INVALID`/`SETUP_TOKEN_CONSUMED` (401), `STALE_REVISION` (409), `INVALID_STATE` (409), `SESSION_FEATURE_MISMATCH` (409), `FUTURE_REVISION` (409, policy ACK for a revision never issued - corrupt device state, never silently ignored), `RATE_LIMITED` (429, retryable), `UNAVAILABLE` (503, retryable), `SETUP_REQUIRED` (503), `MFA_SETUP_REQUIRED` (403, admin routes). Fail closed: an unimplemented or degraded route returns `SETUP_REQUIRED`/`UNAVAILABLE`, never demo data.

## 9. Migration sequencing

- `supabase/migrations/202611090001_control_foundation.sql` is the immutable baseline; never edited.
- Every schema change is a NEW file `supabase/migrations/YYYYMMDDHHMMSS_<snake_name>.sql`, authored and merged only by the maintainer. Contributors file requests; they do not write SQL.
- RLS stays enabled on every table; no anonymous grants; no authenticated-client mutation policies; service-role authorization is application code's job.
- Email module's needed tables (hotel users, setup tokens, delivery state) are migration request #1, expected from the email module with exact columns.
- Testing: disposable LOCAL Postgres (pgTAP or equivalent role-isolation tests) is in scope now; no live Supabase project is required to start. Migration against a real project is a separately authorized external step.

## 10. Clarifications

- `mode` values on heartbeat mirror `devices.mode`: `idle|translation|reception`.
- Auth helper interface (backend module owns all auth files; other modules import, never re-implement). RECONCILED 2026-11-10 02:39 IST: the result-union shape below is the single authoritative interface; the earlier throw-based sketch is withdrawn.
  - `src/lib/auth/admin.ts`:
    `export interface AdminIdentity { userId: string; email: string | null; aal: string }`
    `export type AdminAuthResult = { ok: true; admin: AdminIdentity } | { ok: false; response: Response }`
    `export async function requireEnabledAdmin(request: Request): Promise<AdminAuthResult>`
    Usage: `const auth = await requireEnabledAdmin(request); if (!auth.ok) return auth.response;`
    Fail-closed behavior (all responses `Cache-Control: no-store`): missing/misconfigured Supabase env -> 503 `SETUP_REQUIRED`; no/invalid session -> 401 `UNAUTHORIZED`; session user not an ENABLED `admin_members` row -> 403 `FORBIDDEN`; membership re-checked against the DB on every request via the service-role client; hotel accounts can never pass.
    MFA (spec requirement, no bypass): an enabled admin with one or more authenticator factors must have current AAL `aal2`, else 403 `FORBIDDEN` (message: MFA required). An enabled admin with NO enrolled factor may access ONLY the MFA enrollment flow; every other privileged route returns 403 `MFA_SETUP_REQUIRED`. AAL is checked server-side via `getAuthenticatorAssuranceLevel`, never cached JWT claims. First-admin bootstrap stays trusted SQL per `docs/database.md`; first login goes straight to enrollment.
  - `src/lib/auth/device.ts`: `requireDeviceScope(request)` -> `{ ok: true; scope: { deviceId, hotelId, policy state } } | { ok: false; response }`; Bearer credential matched by SHA-256 hash lookup against `private.device_credentials`. Codes: 401 `UNAUTHORIZED`, 401 `CREDENTIAL_REVOKED`.
  - `src/lib/auth/errors.ts` (backend-owned, importable by every module): `errorResponse(status, code, message, opts?: { retryable?: boolean; retryAfterMs?: number }): Response` emitting the §8 envelope with no-store. No separate `src/lib/http/**` is created.
- New §8 codes (admin routes only, additive): `MFA_SETUP_REQUIRED` (403, no factor enrolled yet), `MFA_REQUIRED` folded into `FORBIDDEN` with an MFA message (no new code).
- Setup credential is never emailed (email module's question, confirmed): hotel onboarding mail carries only the hotel account email/password. The per-installation one-use setup credential for `POST /devices/enroll` is generated server-side at setup time and displayed once in the admin dashboard (hotel portal later); it never appears in email.
- `package.json` and `package-lock.json` are contract-owner files. Contributors file dependency requests; they do not add deps. Approved in principle: `@supabase/supabase-js` + `@supabase/ssr` (backend). Email module uses `fetch` (no dep). Dashboard: none expected.
- Device setup tokens (migration `202611100002`, enroll consumer is backend): `private.device_setup_tokens(token_hash text pk sha256-hex, hotel_id uuid fk, expires_at, consumed_at, consumed_by_device)`; service-role only. Mint route added to §2 (additive clarification): `POST /admin/devices/setup-tokens` (enabled admin, body `{ hotelId: uuid, expiresInHours?: int(1..72) }`) returns the plaintext token exactly once (`{ setupToken, expiresAt }`); only its hash is stored. The token is never emailed (per the setup-credential ruling).
- Auth infrastructure ownership (additive): `src/app/api/v1/auth/**` (Supabase SSR code-exchange callback for recovery/confirm links) and `src/middleware.ts` (page protection) are BACKEND-owned. Dashboard module does not write auth logic; protected pages rely on middleware/server guards built on backend's helpers.
- Heartbeat boot generations (replay ruling, migration `202611100004`): every seen `bootId` is recorded in `private.device_boots`. Only a NEVER-SEEN bootId starts a new generation (sequence may restart); a previously-seen bootId that is not the device's current generation is a replay - `applied=false`, no presence change, no column updates. The per-device row lock serializes concurrent heartbeats. Backend test must cover: boot A seq 1-3, boot B seq 1, then a replayed boot A seq 5 arrives -> applied=false and `last_seen_at` unchanged.
- MFA escape hatch (mechanical, not documentation): `ADMIN_MFA_REQUIRED=false` may be honored ONLY outside production builds (`NODE_ENV !== 'production'`); in a production build the backend must require MFA regardless of the variable, and `.env.example` must not list the flag. Backend implements; integration review verifies.
- Rate limiting (production gate): the in-memory `checkRateLimit` is single-instance only. v1 accepts it for a single deployed instance; a production/multi-instance claim requires a Postgres-backed limiter (table + RPC) or a pinned single replica. Added to the external/production checklist; backend flags it in its PR description.
- Offline admission policy (ruling, spec says explicitly configurable/unresolved): v1 is FAIL-CLOSED for managed starts. When `POST /devices/sessions` is unreachable or returns `admit:false`, the tablet blocks new managed voice starts; it may NOT silently fall back to a cached approval. A cached-offline permit requires a server-issued policy field that does not exist in v1 (reserved for v2). The device surfaces the blocked state locally and keeps reporting heartbeats/diagnostics. This is the conservative default until the user picks an offline service policy.
- Sealed-payload AAD (security ruling): the AES-GCM AAD MUST bind the payload to the JOB IDENTITY (`welcome:<jobId>`), not the recipient email; an email-bound AAD allows cross-job ciphertext substitution for a re-provisioned recipient. Job UUIDs are therefore caller-preallocated: `create_hotel_with_job` and `create_recovery_job` take `p_job_id uuid`; the caller seals with that id before calling. The idempotent branch may return a different existing job id, which the caller then uses. The create-hotel route MUST surface that outcome honestly: when `already_existed` is true the response includes `"duplicate": true` (it never claims a new hotel was created); the adapter reads the flag.
- Admin-issued recovery links: `RECOVERY_LINK_ORIGIN` replaces `RECOVERY_REDIRECT_URL` (the old variable is ignored). Production must match exactly `https://admin.manzanillareception.com`; local HTTP loopback with an explicit port is permitted only outside production. Unset or mismatched origin -> `needs_attention`, nothing sent. Email issuance uses Supabase `generateLink(type=recovery).properties.hashed_token`, never the provider `action_link`, and builds `/api/v1/auth/confirm?token_hash=...&type=recovery&next=%2Freset-password` on that validated origin.
- Recovery confirmation: BACKEND owns `/api/v1/auth/confirm`. GET renders a safe confirmation page without consuming the token (email scanners/prefetch must not burn a single-use link). Only an explicit same-origin POST calls `verifyOtp({ token_hash, type: 'recovery' })`, applies the session cookies, and redirects to the fixed safe reset path. Reject wrong type, malformed/missing input, cross-origin POST, expired or replayed token. Responses use no-store caching and no-referrer policy; no token/session values in logs or third-party resources. Token-bearing URLs must not be included in reports, captures, or analytics.
- User-initiated forgot-password remains PKCE: `/api/v1/auth/callback?next=/reset-password` exchanges `code` for a session; no implicit-fragment fallback. An AAL1 recovery session for a verified-MFA account is challenged before password update and returns to `/reset-password` after successful MFA. Invalid `next` values fall back to an allowlisted same-origin path, never an external origin. Supabase project redirect allowlisting remains an additional layer. Admin-issued and user-initiated recovery each require a fresh-browser real-GoTrue password-rotation check before readiness claims.
- Auth-create reconciliation (email module ruling, adapter requirement): the Supabase AuthAdmin adapter MUST set `app_metadata.provisioning_job_id = <job id>` on `createUser` (app_metadata is server-set; never user_metadata). On a retry that hits an email conflict, the job treats the existing user as its own ONLY when the marker matches; otherwise `needs_attention` and nothing is sent.
- Delivery terminals (email review B, accepted design): `bounced`, `failed` and `complained` are all terminal rank 4; the first terminal state wins and later terminal events for the same message id are recorded as webhook events but do not change state. Mapper: Resend `suppressed` -> `failed`, `complained` -> `complained`.
- Provisioning jobs (migration `202611100001` REV 3, after email module review): claim via `private.claim_provisioning_job(job_id, worker, lease_seconds)` (atomic conditional update; expired leases reclaimable; `needs_attention` is NOT claimable - it is terminal until an operator calls `private.requeue_provisioning_job(job_id)`, which resets the same row to `pending`, clears lease/error, and does NOT extend the original deadline). Stage writes allow only legal transitions: `pending -> auth_created|sent|needs_attention`, `auth_created -> sent|needs_attention`, `sent -> done|needs_attention`; a leased worker cannot regress or revive a job. `p_clear_error=true` clears `last_error`. Stage writes go through `private.provisioning_stage_write(...)` and releases through `private.release_provisioning_job(job_id, worker)`; both fence on `lease_owner` + unexpired `lease_until` inside SQL, so a lost lease writes zero rows. Sealed payloads live only in `private.provisioning_jobs`, wiped via `provisioning_stage_write` with `p_set_sealed=true, p_sealed_password=null`; admin status reads go through `public.provisioning_job_status(hotel_id)` (security definer, non-secret columns, enabled admins only). `provisioning_jobs.kind` has no `alert` - alert mail is tracked in `alert_notifications`.
- Delivery ordering and webhook races (REV 2 rulings): the send path inserts the `email_deliveries` row immediately after provider acceptance, before returning. A webhook for an unknown `provider_message_id` returns 500 so Resend retries; the webhook never upserts and never invents `kind`. All delivery state advances go through the rank-ordered RPCs `private.advance_email_delivery` (queued0 < accepted1 < delayed2 < delivered3 < bounced/failed4; delayed may repeat; terminal per message id) and `private.advance_alert_notification` (pending0 < sent1 < delivered2 < bounced/failed3). No read-then-write state advance in application code. `alert_notifications` dedupes on `unique(incident_id, recipient)`; ACK columns stay separate from delivery state. `private.webhook_events` grants DELETE to service_role for the retention purge.
- Public RPC wrappers (migration `202611100003`): Supabase does not PostgREST-expose the `private` schema, so every private RPC the modules call gets a thin `public.<same_name>` wrapper, security definer, granted to service_role ONLY (revoked from public/anon/authenticated). Authorization stays in application code; wrappers change nothing about who may do what.
- Device-side audit (ruling on the backend's conflict): `admin_audit` stays ADMIN-ONLY; device-originated ACKs never write it (its `actor_id` references admin membership). The device-side policy record is the stored `policy.ack` technical event plus the monotonic `devices.ack_revision`. §5's "appends audit in the same transaction" applies to admin mutations only. Freshness columns `devices.last_boot_id`/`last_heartbeat_sequence` and idempotency refs `voice_sessions.client_session_ref` (unique per device), `session_attempts.client_attempt_ref` (unique per device) are added by `202611100003`.
- Dependency reconciliation: the backend module's branch carries the two approved deps (`@supabase/supabase-js`, `@supabase/ssr`) and the resulting package.json/package-lock.json changes; that branch's versions are the canonical base at integration. All other modules keep package files untouched; further dependency requests still route through the maintainer.
- SQL-level MFA (migration `202611100002`): `private.is_enabled_admin()` is replaced to require `auth.jwt() ->> 'aal' = 'aal2'` in addition to enabled membership. Because every baseline admin-read policy calls this function, the one replacement tightens all direct PostgREST admin reads at once; service_role is unaffected, and the no-factor enrollment flow touches only Supabase Auth APIs. Local disposable-Postgres tests must stub the auth schema (`auth.users`, `auth.uid()`, `auth.jwt()` with an `aal` claim).
- Presence classes for the dashboard: `online` < 90 s since fresh heartbeat (pilot target), `stale` 90 s–10 min, `offline` > 10 min, `never-seen` null. These are display classes, not stored state.
- Hotel create + recovery shapes (REV 13, email module c85bac1 measured): `POST /admin/hotels` -> 202 `{ hotelId, jobId, duplicate, status, nextStep? }`; `nextStep: "use_recovery"` appears ONLY when status is `needs_attention` (sealed password gone; requeue cannot resend). A job-execution throw after creation still returns 202 with the durable status (never a 500 that invites re-creation). `POST /admin/hotels/[hotelId]/recovery` body `{ mode: "guide" | "reset_link" }` (required) -> 202 `{ jobId }`, 404 unknown hotel. Dashboard action copy must match the chosen mode (guide = sign-in guide without password; reset_link = password reset), never promise both.
