# Manzanilla Admin

A separate dashboard foundation for the Manzanilla team's device operations. It contains **four tabs: Devices, Feature usage, Traffic, and Failures**. It does not connect to the existing Manzanilla repository or to real devices.

Source repository: https://github.com/dan-labs-ai/manzanilla-admin

## Run

Use Node 24 and npm:

```sh
npm ci
npm run dev
```

Open the local URL printed by Next.js. No account, API key or `.env` file is needed. All records are synthetic. Device actions change the browser's demo state; reset restores the demonstration. No guest conversations are collected.

```sh
npm run check
npm run preview:build
npm run repair:brief -- INC-1042
```

`preview:build` produces a standalone mockup from the same interface. `repair:brief` validates an incident ID and writes a **disconnected intake template**, not a diagnosis or a code change.

## What the base demonstrates

- Approval and blocking with separate desired policy, acknowledged policy and connection state.
- Logical connected sessions, retry attempts, duration and sampled timing by feature.
- Technical API/session traffic, with denominators and measurement labels.
- Grouped failures, next steps and sanitized repair preparation.
- Typed domain operations, content-free telemetry validation and automated checks.

## What is deliberately not connected

No authentication, database, Android integration, provider session control, real alert delivery, Codex worker, Vercel deployment, email or domains. Changing demo policy cannot stop a real phone or provider call. The Supabase migration is an **unapplied foundation**, not a tested production backend.

The intended next stack is Next.js on Vercel plus Supabase Auth/Postgres in an appropriate EU region. Live audio remains outside this portal. A VM is unnecessary for this control-plane pilot; an isolated repair worker can be added later.

Read [the architecture](docs/architecture.md), [the delivery phases](docs/plan.md), [the /goal handoffs](docs/GOALS.md), [the integration contract](docs/device-contract.md), [the repair boundaries](docs/repair-pipeline.md), and [the database notes](docs/database.md). This public source repository is authorized for publication. Hosting, backend setup and Android changes remain separate integration work.

The [pending APK integration handoff](docs/apk-integration-handoff.md) records the user’s instruction to integrate the forthcoming Manzanilla app source when they push and identify that version.
