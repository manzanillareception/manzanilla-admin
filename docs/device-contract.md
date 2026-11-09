# Versioned integration contract — planned, not live endpoints

The browser demo is not an authorization service. These routes are the intended `/api/v1` boundary after phase 2; no device integration is claimed yet. The three implemented stubs (`POST /api/v1/devices/heartbeat`, `POST /api/v1/events/batch`, and `POST /api/v1/admin/devices/:deviceId/policy`) return HTTP 503 `SETUP_REQUIRED` until trusted adapters exist. Other routes below are design contracts only. The runtime telemetry schema in `src/domain/telemetry.ts` is the initial allowlist and must stay in sync with implementation before Android adoption.

| Planned route | Caller | Responsibility |
|---|---|---|
| `POST /devices/enroll` | One-use setup credential or hotel flow | Bind one installation to a server-selected hotel; return scoped credential; begin pending |
| `POST /devices/heartbeat` | Valid installation credential | Record fresh server-observed presence; return latest policy/revision |
| `POST /events/batch` | Valid installation credential | Bounded batch, exact schema, replay handling, deduplication; no guest content |
| `POST /devices/policy-ack` | Valid installation credential | ACK current revision; record receipt separately from provider termination |
| `POST /devices/sessions` | Approved installation | Transactionally reserve logical session; authorize provider; recheck policy before returning connection data |
| `POST /admin/devices/:deviceId/policy` | Enabled internal admin | Expected revision, desired state, reason; atomic revision advance + immutable audit |
| `POST /admin/incidents/:id/repair` | Enabled internal admin | Build server-owned sanitized brief; never execute device text |

Admin and device identities are different. Derive hotel/device scope from the authenticated credential; never trust `hotelId`, `deviceId`, arbitrary provider call IDs or role claims supplied in telemetry JSON. Store only a hash of a high-entropy installation credential; return it once during enrollment and secure it in Android Keystore-backed storage. Reinstallation can require re-enrollment. Do not put provider master keys in a managed-fleet APK or allow an unrestricted alternative key path that bypasses policy.

## Envelope rules

The concrete schema must version the envelope and bound the number and size of events. Each event has a stable `eventId`, event kind, timestamp and bounded typed measurements. Session events have stable logical `sessionId` and `attemptId` where applicable. A fresh heartbeat additionally has a boot generation/sequence or equivalent replay-resistant freshness mechanism. Use the runtime schema's exact names; adding transport fields requires a versioned contract review.

- Reject unknown fields instead of silently retaining arbitrary metadata.
- Deduplicate `(authenticated device, eventId)` transactionally. Re-uploading an accepted batch cannot inflate counters.
- Limit batch size, body bytes and per-device request rate. Return retryable errors with backoff/jitter; cap the device's offline queue.
- Preserve original event time and server receipt time. Bound future clock skew and mark late history; old events never update `last_seen_at`.
- Do not allow late `connected` events to reopen an ended logical session. Attempt end is monotonic. Keep uncertain/provisional durations explicit.
- Invalid/revoked devices cannot submit telemetry; a service-blocked device with a valid credential may still send diagnostics and ACKs.
- Admin mutations use optimistic revision checks. A stale ACK never changes a later policy; repeated identical requests are idempotent.

## Call-control races

Reserve the logical session and capacity slot before provider creation. Save the provider handle durably, recheck access, then release connection data. Idempotency belongs to the application operation; do not assume a provider supports duplicate-create protection. If create returns an unknown result, reconcile instead of opening another call blindly. If access changes during creation, withhold the response and clean up. Provider stop timeout stays pending and is retried; device ACK and provider confirmation remain distinct.

The planned backend returns `SETUP_REQUIRED`/unavailable until auth, persistence and provider capabilities are configured. It must fail closed. Never expose demo policy or a sample provider token as a working production route.
