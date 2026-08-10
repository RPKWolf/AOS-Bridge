# AOS Dashboard Architecture Review and Implementation Plan

**Review date:** 2026-08-10

**Scope:** current `main` codebase of `aos-bridge` and all reachable Git history

**Change scope:** analysis and implementation plan only; this document proposes no production-code, AOS core, business-logic, or Compass-strategy changes.

## Executive Summary

The real AOS Dashboard in this repository is the local, server-rendered control page
at `GET /control`. Its HTML, CSS, and browser JavaScript are embedded as
`CONTROL_PAGE` in `src/gateway/local-bridge-server.ts`. It is an intentionally
minimal local operator UI: it checks `GET /health`, submits a prompt to
`POST /api/v1/tasks`, polls the task status, and fetches a completed result.

The foundation is appropriate for an MVP. The AO boundary is isolated behind
`OrchestratorAdapter` and `AoRestAdapter`, and the dashboard talks only to the
local Bridge HTTP API. The immediate architectural risk is not a missing UI
framework. It is duplicated task ownership and lifecycle policy:

- `LocalBridgeGateway`, `BridgeCore`, and `AgentOrchestratorAdapter` each retain
  task-related state;
- `POST /api/v1/tasks` and `POST /api/v1/agent-task` create different task
  paths but share status/result reads;
- the dashboard and both CLI clients each poll independently; and
- all task mappings disappear on restart.

The recommended target remains a **small modular monolith**. Keep the current
HTTP endpoints, loopback-only deployment, `BridgeCore`, and AO adapter contract.
First make one canonical task lifecycle behind the existing gateway. Then move
the dashboard asset out of the HTTP routing module without changing `/control`.
Persistence, observability, and any new dashboard workflow should follow only
after explicit decisions and contract coverage.

No approved Dashboard Design Authority was found in the current tree or any
reachable Git commit. `docs/architecture/ORCHESTRATION_LAYER_ARCHITECTURE.md`
is a proposed architecture for a separate orchestration control plane, not a
Dashboard design authority. Consequently, the gap analysis distinguishes
verified requirements from decisions that must be approved before implementation.

## Current State

### Identified Dashboard and runtime boundary

| Item | Verified state |
| --- | --- |
| Dashboard entry point | `GET /control` in `src/gateway/local-bridge-server.ts` |
| UI delivery | One inline HTML string with inline CSS and browser JavaScript |
| Local deployment | `listenOnLoopback` always binds to `127.0.0.1` |
| Public task API used by UI | `POST /api/v1/tasks`, `GET /api/v1/tasks/{id}`, `GET /api/v1/tasks/{id}/result` |
| Additional task API | `POST /api/v1/agent-task`; it has a separate adapter-owned lifecycle |
| AO integration | `AoRestAdapter` uses AO public Chat REST endpoints through `OrchestratorAdapter` |
| Orchestration Layer | Present in `src/orchestration/`, but not connected to `/control` or the local HTTP server |
| Storage | In-memory maps only; state does not survive process restart |
| Existing dashboard test | One HTTP smoke assertion that `/control` returns HTML containing the prompt textarea |

### Actual data flows

```text
Dashboard /control (browser)
  ├─ GET /health ──────────────────────────────────────────────────────┐
  └─ POST /api/v1/tasks, then GET status/result ──> LocalBridgeGateway  │
                                                       │                │
                                                       v                │
                                                 BridgeCore             │
                                                       │                │
                                             InMemoryTaskStore          │
                                                       │                │
                                                       v                │
                                             OrchestratorAdapter        │
                                                       │                │
                                                       v                │
                                                  AoRestAdapter ────────┘
                                                       │
                                                       v
                                            AO public Chat REST API

POST /api/v1/agent-task ──> LocalBridgeGateway ──> AgentOrchestratorAdapter
                                                        │
                                                        v
                                                OrchestratorAdapter
```

The status/result routes first ask `AgentOrchestratorAdapter.hasTask(id)` and
otherwise resolve the ID through the gateway map. Thus two submission paths use
the same read URLs but not the same state model.

### Module responsibilities today

| Module | Actual responsibility | Architectural observation |
| --- | --- | --- |
| `src/gateway/local-bridge-server.ts` | HTTP routing, request parsing, error mapping, and the full dashboard asset | Transport and presentation are coupled in one file. |
| `src/gateway/local-bridge-gateway.ts` | API input validation, task-ID-to-handle map, dispatch to one of two task paths | It is an application facade, but also holds one of several registries. |
| `src/core/bridge-core.ts` | Delegates submission/status/result and caches completed result through `TaskStore` | Correctly independent of AO and UI; its store is keyed by backend handle. |
| `src/gateway/agent-orchestrator-adapter.ts` | Alternative task registry, timeout wrapper, polling helper, and AO delegation | It duplicates lookup and lifecycle duties already partly present elsewhere. |
| `src/adapters/ao-rest-adapter.ts` | AO Chat protocol translation, compatibility check, conversation-page traversal | Correct external adapter boundary; every status/result lookup may traverse pages. |
| `src/client/` and `src/cli/` | HTTP clients and local polling loops | Client-side polling policy is repeated. |
| `src/orchestration/` | Separate capability selection and manual PASS/FAIL pilot | It is not a Dashboard backend and must remain outside `BridgeCore` per its architecture document. |

### Implementation maturity

Implemented and usable for a local MVP:

- submit one prompt and observe `pending`, `running`, `completed`, `failed`, or
  `interrupted` states;
- show a completed text output in the control page;
- run the same public task API from the Bridge CLI and Chief Engineer local client;
- translate AO Chat REST calls behind an adapter and verify required endpoints;
- keep the process loopback-only.

Not implemented or not connected to the dashboard:

- task history, multi-task view, reload/restart recovery, cancellation, retry,
  deadlines visible to the UI, streaming, authentication, authorization, or audit;
- a stable dashboard client module, dashboard state model, or browser-level
  regression suite;
- connection from the dashboard to `src/orchestration/` work items, validation
  evidence, decisions, or bounded iterations;
- durable task storage, correlation IDs, structured logging, metrics, and
  readiness semantics.

## Architecture Review

### Strengths to preserve

1. **The AO dependency boundary is sound.** `BridgeCore` depends on the
   `OrchestratorAdapter` port, while `AoRestAdapter` owns AO-specific protocol
   behavior. The dashboard does not call AO directly.
2. **The current UI is thin.** It uses the public local Bridge API instead of
   importing server or AO code into browser logic.
3. **The loopback-only default is appropriate.** With no authentication, the
   enforced `127.0.0.1` bind is a necessary and proportionate safeguard.
4. **The public task API is small and already shared.** Dashboard, CLI, and
   Chief Engineer client provide a concrete compatibility surface to protect.
5. **The current test baseline is useful.** Typecheck, unit tests, server API
   tests, and AO adapter tests provide a safe base for incremental work.

### Architectural weaknesses, duplication, and missing layers

| Priority | Finding and evidence | Risk | Minimal corrective direction |
| --- | --- | --- | --- |
| P0 | Three stores of task-related state exist: gateway `handles`, `BridgeCore` `TaskStore`, and agent adapter `handles`. | Different paths can diverge in existence checks, result caching, timeouts, and future metadata. | Establish one application-level task record/repository; retain an in-memory implementation first. |
| P0 | `/api/v1/tasks` and `/api/v1/agent-task` are two write paths, yet status/result routes select one by map membership. | A task ID collision or a new feature can change which lifecycle serves a read; behavior is hard to reason about. | Decide whether `agent-task` is a compatibility alias or a distinct product contract, then route it through the canonical lifecycle or version/deprecate it deliberately. |
| P0 | IDs are generated with `Date.now()` in dashboard, Bridge CLI, Chief Engineer client, and agent-task path. | Same-millisecond submissions can collide; IDs are a client concern despite server ownership of lifecycle. | Add server-issued IDs with a defined idempotency rule; keep client IDs accepted during migration. |
| P1 | `CONTROL_PAGE` is presentation, API client, polling, and view state inside an HTTP router. | UI changes require transport edits; browser behavior is difficult to unit-test or review independently. | Extract a dependency-free dashboard asset/module; keep server responsibility limited to serving it at `/control`. |
| P1 | Polling is independently implemented in dashboard, Bridge CLI, Chief Engineer CLI, and `waitForTaskResult`. | Different timeouts, retry behavior, terminal handling, and unnecessary AO load. | Define task deadline and terminal-state policy once in the application layer; clients only observe it. |
| P1 | `AoRestAdapter` searches AO conversation pages on status and result reads. | Latency and AO request volume grow with session history; UI polling amplifies this. | Measure first; cache only safely known handle/terminal data behind the AO adapter or task repository. Do not expose AO pagination to the UI. |
| P1 | `readJson` buffers an unbounded request body; AO fetch calls have no `AbortSignal` deadline. | Local resource exhaustion and hung outbound calls; severity increases if deployment scope changes. | Add explicit input-size and outbound-deadline policy as a separate hardening change. |
| P1 | The error mapper has no specific mapping for `AgentTaskFailedError`, although it is declared and can be raised by polling. | Clients cannot distinguish task failure from generic bridge failure consistently. | Define and freeze the public error-envelope mapping with contract tests before changing behavior. |
| P2 | `AIAdapter`, `OrchestratorStatus`, error metadata, and runtime metadata are declared but unused by the running dashboard path. | They imply capability the system does not yet offer. | Document as reserved or introduce only when a concrete use case needs them. |
| P2 | No correlation ID, structured task events, metrics, or readiness endpoint exists. | Diagnosis of AO failures and performance regressions is weak. | Add a small observability port only after canonical task records exist. |

### Inappropriate dependencies and regression hotspots

- The dashboard’s only intended dependency is the local HTTP contract, but its
  physical co-location with the Node HTTP router makes it depend on transport
  edits in practice. Extracting its asset is a boundary repair, not a new frontend
  framework.
- `LocalBridgeGateway` depends on both `BridgeCore` and `AgentTaskAdapter`; that
  forces it to know two implementations of the same use case. The gateway should
  depend on one task-facing application port.
- The `src/orchestration` pilot is currently independent of the Dashboard. Do
  not shortcut this boundary by importing orchestration internals into the page
  or `BridgeCore`; its own architecture explicitly prohibits that coupling.
- The most regression-prone changes are ID generation, task lookup, response
  envelopes, terminal statuses, and `/control` asset serving. Each needs
  contract coverage before internal consolidation.

## Gap Analysis Against Approved Dashboard Design

### Authority inventory and conclusion

The repository and reachable history contain no file named or functioning as a
Dashboard Design Authority, approved dashboard specification, or Compass
dashboard strategy. `docs/PROJECT_STATUS_v1.md` references
`docs/architecture/01_BRIDGE_ARCHITECTURE_AUTHORITY_v1.0.md`, but that file is
not present in the current tree or reachable history. A prior unmerged commit
contains a general review (`ARCHITECTURE_REVIEW.md`), which is not an approved
authority and is not used as a normative source here.

Therefore there is no approved Dashboard proposal to compare feature-by-feature.
The only available architecture constraints are the verified implementation and
the proposed Orchestration Layer document. The following is a gap analysis
against those constraints, not a claim of approval.

| Available constraint | Current dashboard state | Gap / implication |
| --- | --- | --- |
| Dashboard is a local Bridge client | Satisfied: browser calls local HTTP API only. | Preserve this boundary. |
| BridgeCore must remain provider- and orchestrator-neutral | Satisfied by the dashboard path. | Do not move AO or orchestration policy into UI or core. |
| Orchestration Layer is a separate client-side control plane above Bridge API | Not integrated with `/control`. | A future orchestration dashboard requires a separate API client/view model; it must not make the current task page reach into `BridgeCore`. |
| Original orchestration prompt and outputs are immutable, with explicit PASS/FAIL evidence | Current page has only one prompt/result and no decision history. | This is an unimplemented capability, not a defect, until a Dashboard authority approves orchestration visibility. |
| Bounded iteration and capability selection belong outside Bridge | No UI controls or display exist. | Do not add them ad hoc; first approve UX, authorization, audit, and API contract. |
| Existing Bridge HTTP contracts remain unchanged | Current page uses them. | Internal migration must retain exact routes, payload fields, and status semantics. |

### Approval gates before expanding the Dashboard

Before implementing anything beyond safe structural separation, the designated
Dashboard/Architecture Authority should approve:

1. whether `/control` remains a single-task local operator page or becomes a
   dashboard for orchestration runs;
2. whether `POST /api/v1/agent-task` is an alias, a separate public contract, or
   a deprecation candidate;
3. server-issued ID and idempotency semantics;
4. retention/recovery requirements and the intended persistence boundary;
5. the user-facing deadline, retry, cancellation, task-history, and error
   behavior; and
6. any exposure of orchestration decisions, including who may issue PASS/FAIL.

Until these decisions exist, the safe work is contract characterization,
internal task-lifecycle consolidation, and dashboard extraction with unchanged
behavior.

## Risks and Priorities

### P0 — resolve before adding dashboard capability

1. **Canonical task lifecycle and ownership.** The multiple maps and two write
   paths make every status/result feature risky. Choose one task application
   service and repository model first.
2. **`agent-task` semantic decision.** The current route is indistinguishable
   to shared reads but has distinct behavior. Document and test its intended
   contract before unifying or retiring it.
3. **Identifier collision/idempotency policy.** Replace timestamp-only creation
   with server-side IDs and an explicit duplicate-submission result; preserve
   old clients through a compatible transition.
4. **Contract baseline.** Freeze existing successful and error responses before
   moving internal responsibilities.

### P1 — complete after P0, before product expansion

1. Extract the dashboard asset/client from the HTTP router while retaining
   `GET /control` and API calls.
2. Establish one deadline/terminal-state policy and remove duplicated polling
   decisions where feasible without changing client contracts.
3. Add bounded request bodies, outbound AO deadlines, and a complete public
   error mapping.
4. Decide AO session lifecycle and measure conversation-page lookup costs.
5. Specify a repository persistence/recovery design, but do not add a database
   without a retention and operational decision.

### P2 — operational readiness and authorized expansion

1. Add correlation IDs, structured events/logs, metrics, and readiness checks.
2. Automate AO compatibility checks against explicitly supported builds.
3. Add task history and orchestration-run dashboard views only after the
   approval gates above are satisfied.
4. Remove or document unused contract placeholders.

## Recommended Target Architecture

This is a modular-monolith target. It introduces no framework, message broker,
database, or frontend build system by default.

```text
interfaces/
  http/                 routes, DTO parsing, public error mapping
  dashboard/            dependency-free HTML/CSS/JS and small API client
  cli/                  thin clients of the same HTTP contract

application/
  tasks/                submit, status, result use cases; deadline/idempotency policy
  ports/                TaskRepository, OrchestratorAdapter, IdGenerator, Clock

core/
  bridge/               existing provider-neutral BridgeCore responsibility

infrastructure/
  ao/                   existing AoRestAdapter and AO protocol reading
  storage/              in-memory repository first; durable adapter only when approved
  runtime/              composition root and loopback Node server
```

Rules:

- The dashboard, CLI, and orchestration layer call public HTTP/application
  contracts; none imports AO protocol code.
- `BridgeCore` stays unaware of dashboard views, roles, PASS/FAIL decisions,
  iteration budgets, or browser state.
- One task service owns task-ID allocation, mapping, status/result lookup, and
  terminal record updates. It delegates backend work through the existing
  adapter boundary.
- The HTTP server only routes, parses bounded inputs, serializes stable
  responses/errors, and serves `/control`.
- The dashboard remains plain, dependency-free browser code unless a later
  approved UX need proves a framework beneficial.
- Orchestration remains a separate control plane. A future dashboard section
  consumes its explicit API; it does not merge it into core task lifecycle.

## Concrete Implementation Plan: Small, Safe Steps

Each step is intentionally independently reviewable and should be delivered as
one focused PR after the current documentation PR.

### Step 0 — Capture decisions and compatibility baseline (P0)

**Work:** Create a short ADR recording canonical task semantics, `agent-task`
status, ID/idempotency rules, and whether persistence is in scope. Add HTTP
contract tests/fixtures for health, control, all task routes, duplicate IDs,
terminal states, malformed JSON, and every published error envelope.

**Acceptance criteria:**

- Authority decisions are recorded and linked from the implementation PRs.
- Tests assert current route, status code, response field, and error-code
  behavior before any refactor.
- `npm run typecheck`, `npm test`, and `git diff --check` pass.

### Step 1 — Introduce one task application port with unchanged behavior (P0)

**Work:** Define a narrow task-facing application interface behind
`LocalBridgeGateway`. Move existing submit/status/result coordination into it
without changing external requests or responses. Keep an in-memory
implementation and delegate to the existing `BridgeCore`/adapter boundary.

**Acceptance criteria:**

- Gateway calls one task application port, not both core and agent-task paths.
- Existing task HTTP contract fixtures pass unchanged.
- Task result caching and terminal status behavior remain demonstrably the same.
- No AO-specific type crosses into HTTP or dashboard modules.

### Step 2 — Consolidate task records and resolve `agent-task` (P0)

**Work:** Implement the Step 0 decision: make `agent-task` a compatible facade
over the canonical task service, or start the explicitly approved deprecation
path. Replace parallel ID-to-handle maps with one repository/task record. Add
server ID generation while temporarily accepting a client-supplied ID under the
approved idempotency rule.

**Acceptance criteria:**

- A status/result lookup is served by one canonical record regardless of
  submission route.
- Concurrent-ID and duplicate-submission tests prove the documented behavior.
- Existing dashboard, Bridge CLI, and Chief Engineer client still complete an
  unchanged task workflow.
- Process-restart behavior is explicitly documented as either intentionally
  in-memory or covered by an approved repository implementation.

### Step 3 — Extract the dashboard without changing UX (P1)

**Work:** Move inline `CONTROL_PAGE` into a dedicated dependency-free dashboard
asset/module. Keep `GET /control`, title, form fields, API requests, polling
interval, and displayed states unchanged initially. The HTTP server serves the
asset and contains no dashboard behavior.

**Acceptance criteria:**

- `GET /control` retains its route and content type.
- Browser smoke coverage proves health display, submit request, status update,
  completed output, and visible error handling against a stub server.
- Server route tests no longer need to assert embedded implementation details
  beyond asset delivery.
- No UI framework, build pipeline, or production-code business rule is added.

### Step 4 — Centralize lifecycle hardening (P1)

**Work:** Add approved deadline and terminal-state policy to the task
application service. Set bounded request size and AO fetch deadline/abort
behavior. Complete the error mapper and make client polling reflect the same
terminal semantics.

**Acceptance criteria:**

- Tests cover failed, interrupted, timeout, malformed, oversized, and
  unavailable-backend paths with stable error envelopes.
- Dashboard and both CLIs stop consistently on all terminal statuses.
- AO requests cannot wait beyond the documented deadline.
- No implicit retry or changed Compass/business policy is introduced.

### Step 5 — Measure AO access and add low-risk observability (P1/P2)

**Work:** Add correlation IDs and structured lifecycle events at the task-service
boundary. Measure AO conversation-page requests under polling. Only then add a
safe cache for immutable terminal data or an adapter-local optimization.

**Acceptance criteria:**

- A task can be traced from HTTP request to backend handle without logging
  prompt/output content by default.
- Tests prove correlation propagation and no change to public payloads unless
  versioned/approved.
- Performance changes include before/after measurement and preserve AO adapter
  protocol tests.

### Step 6 — Durable storage, history, and orchestration views (P2; approval required)

**Work:** Only after retention, recovery, and Dashboard Authority approval,
implement a persistent `TaskRepository` adapter and, separately, a task-history
or orchestration-run view. The orchestration view must consume explicit
orchestration outcomes/decision records and must not extend `BridgeCore`.

**Acceptance criteria:**

- Restart/recovery semantics, retention, migration, and deletion policy are
  documented and tested.
- History access and any PASS/FAIL action have approved authorization/audit
  semantics before network exposure.
- Existing `/control` single-task workflow remains backward compatible.
- The Orchestration Layer architecture constraints remain satisfied.

## Recommended Implementation Order

1. This architecture review and authority decisions.
2. Step 0 contract baseline.
3. Step 1 task application port.
4. Step 2 canonical records, `agent-task`, and IDs.
5. Step 3 dashboard extraction.
6. Step 4 lifecycle hardening.
7. Step 5 measurement/observability.
8. Step 6 only after explicit product and operational approval.

The order protects the shared HTTP surface first, removes hidden branching
second, and changes the visual delivery mechanism only after the backend model
is stable. It avoids a costly UI rewrite and prevents orchestration features
from silently changing Bridge semantics.

## Test and Regression Protection

| Protection | When introduced | What it must prove |
| --- | --- | --- |
| Typecheck and existing Node tests | Every PR | No TypeScript or existing behavior regression. |
| HTTP contract fixtures | Step 0 | Route, status, headers, body fields, and error envelope compatibility. |
| Task lifecycle tests | Steps 1–2 | Exactly one canonical record; duplicate/idempotency and terminal-state rules. |
| Adapter protocol tests | Steps 1–5 | AO request paths, pagination, protocol errors, and supported state mapping. |
| Browser smoke test for `/control` | Step 3 | Submit → poll → result and visible failure path using the stable API. |
| Boundary tests | Steps 1–6 | Dashboard/HTTP/application modules do not import AO implementation internals. |
| Timeout and input-limit tests | Step 4 | Bounded work and stable client-facing failure. |
| Recovery/retention tests | Step 6 | Approved persistence semantics across restart and retention transitions. |

Do not use live AO as the only regression proof. Retain deterministic adapter
fixtures/mocks for PR checks; run a separately labeled, opt-in compatibility
smoke test against the documented AO build when credentials/runtime are present.

## Git and PR Strategy

- Keep this document as a docs-only PR. It changes no runtime behavior.
- Create one focused branch and conventional commit per implementation step, for
  example `refactor(task): add canonical task application port`.
- Target `main` unless a dependency PR remains open; if work must be stacked,
  target the preceding step and rebase/retarget only through normal review flow.
- Each PR description must include: linked ADR/authority decision, scope,
  unchanged public contracts, tests run, rollback method, and deferred risks.
- Do not combine persistence, UI redesign, orchestration controls, or external
  network exposure with the P0 consolidation PRs.
- Require review from the Architecture/Dashboard Authority for Step 0 decisions
  and Step 6 capabilities; require test evidence before merging each step.
- Keep commits additive and reversible. No force-push or history rewrite is
  required for this plan.

## P0 Conclusions

1. The real Dashboard is the local `/control` page, not a separate application.
2. Its AO integration boundary is correct, but task ownership is split across
   parallel paths and maps; this is the first implementation risk to remove.
3. `agent-task` semantics and task-ID/idempotency ownership are unresolved and
   must be decided before adding dashboard features.
4. No approved Dashboard Design Authority is available in this repository or
   reachable history. Do not represent future orchestration views as approved
   work until the listed authority gates are resolved.
