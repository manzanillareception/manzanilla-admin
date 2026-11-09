# Pending APK integration — user instruction, 9 November 2026

The user instructed us to implement the device integration in the new Manzanilla app version after they push and identify its source. Do not change the current old app as part of the local admin mockup. No automatic GitHub watcher has been configured.

## Required behavior

- Hotel email/password authenticates the hotel once. Do not use the shared password as the continuing credential for every device request.
- Register each installation under the authenticated hotel, issue its own scoped credential, and begin with pending service access. The server derives hotel/device scope from authentication.
- Preserve enrollment across normal restart and update using native secure credential storage. Normal service blocking must not revoke credentials or erase app settings/memory.
- Send fresh heartbeats and ACK the exact policy revision. Desired access, last confirmed access, connectivity and provider termination stay separate.
- Report bounded technical feature events for translation/reception, durations, connection attempts/retries, API traffic and typed failure codes. Never send guest conversations, audio, transcripts, prompts, room numbers or arbitrary logs.
- Broker new voice-session admission and verify provider-specific cancellation support before claiming managed enforcement. Preserve working voice UX and direct audio transport.
- Keep reporting available to service-blocked devices with valid credentials. A revoked installation cannot authenticate.

## Prove it before claiming monitoring works

Use two installations to show separate device records and approvals; use two hotels to prove isolation. Verify observed usage/failure events appear under the correct device, retries do not inflate sessions, late uploads do not refresh presence, offline blocks stay pending and policy ACK does not imply provider termination. Test update/reboot credential persistence and confirm no guest content appears in storage, dashboard, exports or logs.

The current admin interface is synthetic. Authentication, live storage and Android/provider integration must be connected before any real tracking or enforcement can be demonstrated.
