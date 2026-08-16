# AOS-Bridge

A minimal TypeScript bridge between a caller and Agent Orchestrator (AO) Chat-mode sessions.

## Architecture

- `src/types/` — provider-neutral task contracts and task handles.
- `src/adapters/` — the `OrchestratorAdapter` contract and AO public REST implementation.
- `src/core/` — `BridgeCore` lifecycle delegation plus an in-memory task store.
- `src/cli/` — a manually runnable end-to-end smoke check.

`BridgeCore` delegates task execution to an `OrchestratorAdapter`. `AoRestAdapter` uses only AO's public Chat REST API and checks endpoint compatibility before it is returned by `AoRestAdapter.create`.

## Supported AO version

The MVP requires a Chat-mode AO build exposing both public endpoints:

- `POST /api/v1/sessions/{sessionId}/conversation/messages`
- `GET /api/v1/sessions/{sessionId}/conversation`

The required verified build is `v0.12.1-nightly.202608081014` or a compatible newer Nightly build.

## Validation

```sh
npm run typecheck
npm test
```

## Local Gateway

Start the loopback-only local server:

```sh
AO_BASE_URL=<base-url> AO_HARNESS=<harness> AO_DISPLAY_NAME=<display-name> npm run bridge:server
```

The server always binds to `127.0.0.1`; `BRIDGE_HOST` MAY be set only to `127.0.0.1`, and `BRIDGE_PORT` defaults to `8787`.

Available endpoints are `GET /health`, `POST /api/v1/tasks`, `GET /api/v1/tasks/{id}`, and `GET /api/v1/tasks/{id}/result`.

`POST /api/v1/tasks` continues to accept `{ "id": "...", "prompt": "..." }`. Callers may
select a registered AO project with
`{ "schemaVersion": 2, "id": "...", "prompt": "...", "routing": { "projectId": "aos" } }`.
Without `routing.projectId`, the Bridge proceeds only when AO reports exactly one registered
project. Unknown or ambiguous routing fails before session creation. `AO_PROJECT_ID`, the current
directory, prompt text, and worktree names are not routing inputs.

Run a prompt through the local Gateway. Project selection is optional only when AO has exactly one registered project:

```sh
npm run bridge:cli -- run "PROMPT"
npm run bridge:cli -- run "PROMPT" --project aos
```

The CLI communicates only with the local Bridge HTTP API.

## Chief Engineer Local Client

The Chief Engineer Local Client communicates only with the local Bridge HTTP API. It does not communicate directly with AO. It can submit a task, read its status, and retrieve its final result.

Start the Bridge server first:

```sh
npm run bridge:server
```

Then run the local client:

```sh
npm run chief-engineer:local -- run "Hello"
```

Set `BRIDGE_URL` to override the default local endpoint `http://127.0.0.1:8787`.

## Manual bridge end-to-end check

After installing dependencies, run:

```sh
AO_BASE_URL=<base-url> E2E_PROJECT_ID=<project-id> AO_HARNESS=<harness> AO_DISPLAY_NAME=<display-name> npm run bridge:e2e
```

The command sends exactly `Reply only with: BRIDGE_OK` and prints the task handle, terminal status, and completed output.

## MVP limitations

- Only AO Chat-mode orchestration is implemented.
- Task state is retained only in memory for the running process.
- There is no persistence, retry policy, queue, timeout manager, logging system, streaming API, or AI-provider adapter.

## Chief Engineer continuation

The orchestration coordinator can accept an injected `ChiefEngineerContinuationPolicy`. After a
validated terminal technical phase, the policy receives the full task result, validation,
authority decision, operation-verification evidence, and iteration counters. It records a
structured technical review and either completes, stops for one explicit user decision, reports a
blocker, or submits one safe in-scope follow-up through the existing Bridge client.

`maxIterations` bounds corrective `FAIL` work and `maxContinuations` independently bounds successful
phase-to-phase continuation. A missing continuation policy or a missing continuation budget keeps
the previous behavior. `getChiefEngineerHistory()` exposes the process-local audit trail, including
the reason, next step, task identifier, counters, and timestamp for every continuation or stop.

## Roadmap

1. Add additional orchestrator adapters behind the existing contract.
2. Add durable task storage and operational observability.
3. Add an external Bridge API once the MVP contract is stable.
