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

## Manual bridge end-to-end check

After installing dependencies, run:

```sh
AO_BASE_URL=<base-url> AO_PROJECT_ID=<project-id> AO_HARNESS=<harness> AO_DISPLAY_NAME=<display-name> npm run bridge:e2e
```

The command sends exactly `Reply only with: BRIDGE_OK` and prints the task handle, terminal status, and completed output.

## MVP limitations

- Only AO Chat-mode orchestration is implemented.
- Task state is retained only in memory for the running process.
- There is no HTTP API, persistence, retry policy, queue, timeout manager, logging system, or AI-provider adapter.

## Roadmap

1. Add additional orchestrator adapters behind the existing contract.
2. Add durable task storage and operational observability.
3. Add an external Bridge API once the MVP contract is stable.
