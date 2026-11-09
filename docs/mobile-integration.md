# Manzanilla mobile integration

Version: API v1, 10 November 2026. Based on the hardening rollout after V18.

## Status and configuration

- Control API: `https://admin.manzanillareception.com/api/v1`
- Supabase Auth: `https://hidxtbtzkwujtzqujibm.supabase.co`
- Use this project's public anon/publishable key for Supabase sign-in. Never put a service-role key, database password, email API key or provider secret into the app.
- The portal and database are live. Physical Android enrollment, telemetry delivery and provider behavior are not yet proved end to end. Do not label local fixtures as handset proof.
- Public signup is disabled. A hotel account must be provisioned and mapped to a hotel before app enrollment. An internal admin login is not a hotel login.
- Welcome/recovery sender configuration is saved, but real-inbox delivery is not yet verified. Hotel creation can send mail. Do not use real hotel addresses for tests.

## 1. Hotel login, then installation enrollment

Use Supabase email/password sign-in (`signInWithPassword`). With raw HTTP, the equivalent is `POST /auth/v1/token?grant_type=password` on the Auth host, with `apikey: <public project key>`, `Content-Type: application/json` and `{ "email": "<hotel email>", "password": "<hotel password>" }`. Let the supported Supabase client manage refresh tokens and expiry. Never log credentials or tokens.

Send the resulting hotel access token only to enrollment:

```http
POST /api/v1/devices/enroll
Authorization: Bearer <hotel access token>
Content-Type: application/json
```

```json
{
  "label": "Reception tablet",
  "build": "2.0.0",
  "bootId": "11111111-1111-4111-8111-111111111111"
}
```

200 response:

```json
{
  "deviceId": "22222222-2222-4222-8222-222222222222",
  "deviceCredential": "<returned once>",
  "desiredAccess": "pending",
  "policyRevision": 1
}
```

Store the installation credential in secure device storage. Do not reuse the hotel password for telemetry. The server derives hotel identity from `hotel_users`; never send `hotelId` or `deviceId` in these request bodies.

An assisted alternative is enrollment with a one-use `setupToken` in the same body and no Bearer hotel session. Do not send both. If both are sent, the current server uses the hotel session and does not consume the setup token. A lost enrollment response can require re-enrollment: the device credential is not retrievable later. Do not retry enrollment blindly and create duplicate installations.

Enrollment is not approval. The installation remains pending until an enabled internal admin approves it. The app must show that state clearly.

## 2. Device requests

All routes below are POST with JSON and `Authorization: Bearer <deviceCredential>`. Do not substitute a Supabase user JWT.

| Path after `/api/v1` | Purpose | Body limit | Current rate ceiling |
| --- | --- | --- | --- |
| `/devices/heartbeat` | Presence and policy polling | 8 KiB | 120/device/minute |
| `/devices/policy-ack` | Applied-policy acknowledgement | 4 KiB | 60/device/minute |
| `/devices/sessions` | Gate each new managed voice start | 4 KiB | 60/device/minute |
| `/events/batch` | Usage, failures, diagnostics and update state | 64 KiB | 60 batches/device/minute |

Enrollment has an 8 KiB body cap and 10/IP/minute ceiling. These ceilings use shared Postgres fixed windows across server instances. If the limiter is unavailable, protected routes fail closed with retryable 503 `RATE_LIMIT_UNAVAILABLE`. Respect lower app-side cadences; do not use the ceiling as a polling target.

### Heartbeat

```json
{
  "bootId": "11111111-1111-4111-8111-111111111111",
  "sequence": 1,
  "build": "2.0.0",
  "mode": "idle",
  "microphone": "granted",
  "occurredAt": "2026-11-10T00:00:00Z"
}
```

`mode`: `idle | translation | reception`. `microphone`: `granted | denied | unknown`.

200 returns `desiredAccess`, `effectiveAccess`, `policyRevision`, `serverTime`. Use server receipt time for presence, not the device timestamp. Within one boot, increment `sequence`; a genuinely new boot gets a new UUID. A replay may return 200 without refreshing presence. Reusing an old boot UUID after a newer boot is a replay, not a new generation.

Presence display: online under 90 seconds, stale from 90 seconds to 10 minutes, offline after 10 minutes, never-seen when no fresh heartbeat has ever been accepted. Historical telemetry does not make a device online.

### Apply policy and acknowledge

On a changed policy revision, apply the local access state, then POST:

```json
{ "revision": 2, "bootId": "11111111-1111-4111-8111-111111111111", "sequence": 2 }
```

200: `{ "acknowledged": true, "revision": 2 }`. ACKs are monotonic; a stale ACK must not undo a later policy. Never invent a future revision. Desired state is the server's request; effective state is the device-acknowledged view. Neither proves termination of an existing provider connection.

### Gate new voice sessions

```json
{ "sessionId": "session_123", "attemptId": "attempt_1", "feature": "reception" }
```

200 admitted: `{ "admit": true, "policyRevision": 2, "provider": null }`.

200 denied: `{ "admit": false, "reason": "pending", "policyRevision": 1 }`; reason is `pending | blocked | unavailable`.

Treat `admit:false` as a hard stop even though HTTP is 200. Network failure also blocks new managed voice starts. No cached offline approval exists in v1. An admin block denies new starts immediately, without waiting for ACK.

A logical session keeps one `sessionId` and one feature (`translation | reception`); retries use distinct `attemptId`s. Retry the same attempt with the same IDs to recover its recorded decision. An ended session cannot be reopened, and its feature cannot change.

`provider:null` is intentional. This API does not issue provider credentials or terminate an in-flight voice provider session. Keep provider-stop, app-stop and policy-ACK claims separate.

## 3. Telemetry

```json
{
  "schemaVersion": 1,
  "events": [
    {
      "kind": "diagnostic.snapshot",
      "eventId": "33333333-3333-4333-8333-333333333333",
      "bootId": "11111111-1111-4111-8111-111111111111",
      "sequence": 3,
      "occurredAt": "2026-11-10T00:00:00Z",
      "build": "2.0.0",
      "microphone": "granted",
      "batteryPercent": 85,
      "freeMemoryMb": 1024
    }
  ]
}
```

The timestamps and UUIDs above are examples. Generate fresh values; old example timestamps eventually fall outside the accepted window.

Every event has `kind`, UUID `eventId`, UUID `bootId`, integer `sequence` (0..2147483647), RFC3339 `occurredAt` with offset, and numeric dotted `build` (1..4 segments, 1..4 digits each). Unknown fields reject the whole batch. Keep stable event IDs across offline retries.

Session events also have `sessionId`, `attemptId` and `feature`. Session/attempt IDs are 1..96 characters matching `[A-Za-z0-9][A-Za-z0-9_-]*`.

| Kind | Additional fields |
| --- | --- |
| `session.started` | Session fields only |
| `session.connected` | `firstAudioMs`: integer 0..120000 or null |
| `session.ended` | `durationMs`: integer 0..86400000; `durationProvenance`: `observed | estimated` |
| `connection.failed` | `code`: `CONNECTION_TIMEOUT | MIC_PERMISSION_DENIED | PROVIDER_UNAVAILABLE | AUDIO_STARTUP_TIMEOUT | POLICY_SYNC_FAILED` |
| `policy.ack` | `revision`: integer 1..2147483647; no session fields |
| `diagnostic.snapshot` | `microphone`; `batteryPercent`: 0..100 or null; `freeMemoryMb`: 0..1048576 or null; no session fields |

200: `{ "accepted": 1, "duplicates": 0 }`. Dedupe is transactional by authenticated device and event ID. Replays must never inflate usage. At most 100 events per envelope, at least one; at most 64 KiB total. Events more than 120 seconds in the future or 30 days in the past reject the batch. Offline historical events do not refresh heartbeat presence or reopen ended sessions.

When blocked, continue heartbeats; event batches may contain only `policy.ack` and `diagnostic.snapshot`. Other kinds, including update state, return `DEVICE_BLOCKED`.

### Update reporting, optional schemaVersion 2

Use envelope `schemaVersion: 2` for `update.status`. Version 2 also accepts all six version-1 kinds unchanged. Extra fields: `feedId` (stable feed identity, 1..200 chars), `state` (`up_to_date | update_available | downloading | downloaded | installing | installed | failed`), `currentBuild`, `discoveredVersion` (1..100 chars or null), `publishedAt` (feed release time or null), `progressPct` (0..100 or null), `error` (1..500 chars or null). No session fields. Emit on state changes, otherwise at most once per heartbeat interval. Never include sensitive provider errors or credentials in `error`.

No audio, transcript, caption, prompt, guest identity, room number, provider response body, key or arbitrary metadata belongs in telemetry. Failure codes are allowlisted; traffic figures are derived server-side from reported technical events, not packet capture.

## 4. Error handling

```json
{ "error": { "code": "RATE_LIMITED", "message": "...", "retryable": true, "retryAfterMs": 5000 } }
```

- 400 `VALIDATION_FAILED`: fix schema, field bounds or clock; do not retry unchanged forever.
- 401 `UNAUTHORIZED`: missing/invalid identity. At enrollment, refresh hotel session if expired. After enrollment, recover installation credentials through a deliberate setup flow.
- 401 `CREDENTIAL_REVOKED`: stop credential retries; require re-enrollment.
- 401 `SETUP_TOKEN_INVALID` / `SETUP_TOKEN_CONSUMED`: obtain a new assisted setup token.
- 403 `FORBIDDEN`: wrong account/scope. Hotel accounts cannot read the fleet or perform admin operations.
- 403 `DEVICE_BLOCKED`: stop disallowed events/voice starts; keep permitted diagnostics and policy polling.
- 409 `INVALID_STATE` / `SESSION_FEATURE_MISMATCH`: fix session lifecycle/IDs, never reopen ended sessions.
- 429 `RATE_LIMITED`: honor `retryAfterMs` with bounded exponential backoff and jitter.
- 503 `UNAVAILABLE` / `SETUP_REQUIRED` / `RATE_LIMIT_UNAVAILABLE`: fail closed on new starts; retain a bounded offline telemetry queue and retry only retryable failures.

Do not parse human-readable error text as a stable mobile API. No device can supply its own role or hotel scope.

## Acceptance checklist before claiming handset support

1. Provision a test hotel without emailing a real hotel; sign in as that hotel in the app.
2. Enroll, persist the installation credential, display pending; prove no fleet access from the hotel JWT.
3. Admin approves; app polls, applies, ACKs; portal shows desired versus effective state separately.
4. Report fresh heartbeats and real session start/connect/end/failure events; verify exact counters and timing in the live portal.
5. Replay the same events and old heartbeat boots; prove no inflated usage or false presence.
6. Block and revoke independently; prove denied new starts, permitted blocked diagnostics and revoked-token rejection.
7. Disconnect network, restart app/device and reconnect; prove bounded queue and fail-closed new starts.
8. Inspect physical-device pixels and measured audio behavior before calling Android/provider behavior proved.

Source of truth for complete technical details: `docs/api-v1-contract.md`, route schemas in `src/lib/api/schemas.ts`, telemetry schemas in `src/domain/telemetry.ts`, and the matching SQL migrations. This brief documents current behavior, not a security certification or a claim of completed physical-device testing.
