# Foundation verification — 9 November 2026

This is a local prototype using synthetic records, not a connected fleet.

## Automated checks

- TypeScript and Next.js route generation pass.
- 31 tests cover policy revisions and receipts; legacy/revoked/offline denial; logical-session counts; cross-day retries; concurrency; early-day synthetic history; telemetry allowlists, deduplication and timestamps; repair export boundaries; disconnected intake input validation; and fail-closed API responses.
- Next.js production compilation and static page generation pass.
- Standalone HTML builds from the same React component. Its content security policy blocks network connections. No external fonts or assets are needed.

## Browser checks

The shared React interface was tested through the standalone HTML in managed Chrome at desktop width and in a 375px iframe viewport. Checked:

- All four tabs and hotel/device/feature filters.
- Approval followed by a separate simulated device receipt.
- An offline block retaining old confirmed access and disabling receipt simulation.
- Browser-local persistence after reload and demo reset.
- Hotel-scoped failure counts and explicit group-wide occurrence labels.
- Empty timing samples shown as unknown; corrected concurrency within fleet size.
- Sanitized repair JSON download, explicitly targeting an Android handoff for Android failures.
- Narrow-screen navigation, no page-level horizontal overflow, detail dialog and Escape dismissal.

The downloaded repair file contained only the allowlisted technical packet and static playbook. No external pipeline was called. No application errors were observed in the standalone browser checks; unrelated browser-extension errors were excluded.

## Remaining verification

The Next.js development preview in this managed environment encountered an `uv_resident_set_memory` runtime error and development-origin restrictions. Browser QA therefore used the compiled standalone interface. This does not verify the Next.js development server in this environment; the production build passed.

The Supabase migration is unapplied and has not been executed against real Postgres. Authentication, production event ingestion, policy enforcement, provider termination, actual devices, notifications and external repair jobs remain unimplemented/unconnected. GitHub Actions files were validated locally; no hosted workflow has run because this repository has no remote.
