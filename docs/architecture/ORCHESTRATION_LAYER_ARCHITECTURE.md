# Orchestration Layer Architecture

**Status:** Proposed architecture

## Purpose and boundary

The Orchestration Layer SHALL coordinate specialised agents such as Chief Engineer, Architect, Reviewer, and Tester for one requested outcome. It SHALL be a separate client-side control plane above the public Bridge API.

It MUST NOT be added to `BridgeCore`, an `OrchestratorAdapter`, or the Agent Orchestrator API. Bridge SHALL continue to accept and expose the existing task contracts unchanged. The Orchestration Layer SHALL create ordinary Bridge tasks and SHALL observe them only through the existing Bridge task API.

This boundary preserves the Architecture Authority: Bridge remains a provider-neutral and orchestrator-neutral transport and task-lifecycle boundary. The Orchestration Layer owns agent coordination policy; BridgeCore MUST NOT know agent roles, review rules, iteration limits, or workflow graphs.

## Goals

The Orchestration Layer SHALL:

- manage the lifecycle of a coordinated task;
- select a specialised agent from declared capabilities and explicit task requirements;
- submit work through the existing Bridge API;
- validate completed work through designated review and test agents;
- produce an explicit `PASS` or `FAIL` decision;
- make bounded, auditable iterations after `FAIL`; and
- terminate with a final outcome, failure, or interruption.

It MUST preserve the original user prompt. Any role-specific instruction SHALL be added by the Orchestration Layer as a separate orchestration envelope, never by mutating the original prompt held by Bridge.

## Non-goals

The Orchestration Layer MUST NOT:

- change `POST /api/v1/tasks`, task status, task result, or any other Bridge HTTP contract;
- change Agent Orchestrator public REST contracts;
- import AO-specific implementation code;
- replace BridgeCore state management;
- create a queue, scheduler, durable database, or background worker in the Bridge process;
- infer capability from provider, orchestrator, harness, or vendor names; or
- perform unbounded automatic iteration.

Durable workflow recovery, parallel execution, streaming, and cross-process scheduling are deferred. They MAY be introduced only as separately approved capabilities outside BridgeCore.

## Position in the system

```text
Caller / UI / CLI
       |
       v
Orchestration Layer
  |- task lifecycle and policy
  |- agent selection
  |- review and iteration
       |
       v
Existing Bridge HTTP API
       |
       v
BridgeCore -> OrchestratorAdapter -> Worker Runtime
```

The Orchestration Layer SHALL use a Bridge API client. It MUST NOT call AO directly. `ChiefEngineerClient` is an example of such a client for one role; it is not a new Bridge dependency.

## Core concepts

### Orchestration request

An `OrchestrationRequest` SHALL contain a caller-provided identifier, original prompt, required capabilities, and an explicit iteration budget. The request MAY identify a preferred role, but selection MUST be capability based.

### Agent profile

An `AgentProfile` SHALL describe a logical role and verified capabilities, for example `implementation`, `architecture`, `review`, or `testing`. A profile MAY map to a Bridge client configuration, but it MUST NOT expose AO, provider SDK, or runtime-private objects.

### Work item

A `WorkItem` SHALL link a role assignment to the existing Bridge task identifier. It SHALL retain the Bridge task identifier, current canonical `TaskStatus`, input reference, and unchanged output reference when completed.

### Decision

A decision SHALL be exactly `PASS` or `FAIL`. A `FAIL` decision MUST include actionable findings suitable for the next bounded iteration. A decision MUST be based on completed review or test work, not on an assumed worker success state.

## Lifecycle

```text
created
  -> selecting-agent
  -> submitted
  -> waiting-for-work
  -> validating
  -> PASS -> completed
  -> FAIL -> iterating -> selecting-agent
  -> failed | interrupted | exhausted
```

1. **Create.** The coordinator SHALL record the original request and validate that an iteration budget is present and non-negative.
2. **Select agent.** The selector SHALL choose an eligible agent profile solely from required and declared capabilities. If no profile qualifies, the coordinator SHALL terminate with a compatibility failure.
3. **Submit.** The executor SHALL call the existing Bridge task-submission API with the work instruction. It SHALL retain the returned Bridge task identifier.
4. **Observe.** The executor SHALL poll the existing status endpoint at a policy-defined interval. It SHALL map only Bridge canonical statuses into the orchestration state.
5. **Collect.** After `completed`, the executor SHALL obtain the existing Bridge task result and preserve its output unchanged.
6. **Validate.** The coordinator SHALL submit the output or an immutable reference to it to designated Reviewer and/or Tester profiles. The validator SHALL return a `PASS` or `FAIL` decision with findings.
7. **Iterate.** On `FAIL`, the coordinator SHALL stop if the iteration budget is exhausted. Otherwise it SHALL create a new work item with the original request, prior output, and findings. It MUST NOT overwrite a previous work item or result.
8. **Terminate.** On `PASS`, `failed`, `interrupted`, compatibility failure, or exhausted budget, the coordinator SHALL publish one terminal orchestration outcome.

Transport errors from Bridge SHALL be surfaced without reinterpretation. Timeout policy belongs to the Orchestration Layer and MUST apply once per submitted work item; it MUST NOT create implicit retries.

## Component contracts

The following TypeScript-like contracts are architectural interfaces only. They SHALL NOT change current Bridge interfaces.

```ts
type DecisionStatus = "PASS" | "FAIL";
type OrchestrationStatus =
  | "created"
  | "selecting-agent"
  | "submitted"
  | "waiting-for-work"
  | "validating"
  | "iterating"
  | "completed"
  | "failed"
  | "interrupted"
  | "exhausted";

interface AgentCapabilities {
  readonly roles: readonly string[];
  readonly capabilities: readonly string[];
}

interface AgentProfile {
  readonly id: string;
  readonly capabilities: AgentCapabilities;
}

interface OrchestrationRequest {
  readonly id: string;
  readonly prompt: string;
  readonly requiredCapabilities: readonly string[];
  readonly maxIterations: number;
}

interface BridgeTaskClient {
  submitTask(prompt: string): Promise<string>;
  getStatus(taskId: string): Promise<TaskStatus>;
  getResult(taskId: string): Promise<TaskResult>;
}

interface AgentSelector {
  select(request: OrchestrationRequest, profiles: readonly AgentProfile[]): AgentProfile;
}

interface WorkExecutor {
  submit(profile: AgentProfile, prompt: string): Promise<string>;
  getStatus(taskId: string): Promise<TaskStatus>;
  getResult(taskId: string): Promise<TaskResult>;
}

interface ResultValidator {
  validate(request: OrchestrationRequest, result: TaskResult): Promise<ReviewDecision>;
}

interface ReviewDecision {
  readonly status: DecisionStatus;
  readonly findings: readonly string[];
}

interface OrchestrationCoordinator {
  start(request: OrchestrationRequest): Promise<OrchestrationOutcome>;
  getStatus(id: string): Promise<OrchestrationStatus>;
}
```

`BridgeTaskClient` SHALL be implemented using the existing Bridge API client. `WorkExecutor` MAY hold one `BridgeTaskClient` per logical agent profile, but all implementations MUST remain Bridge-only clients. `AgentSelector` and `ResultValidator` SHALL be deterministic for equal inputs and profile declarations.

## Agent selection

Selection SHALL use set containment: every required capability MUST be declared by the selected profile. Role labels are descriptive and MAY guide caller intent, but they MUST NOT override missing capabilities.

For example, a task requiring `implementation` and `review` MAY select a Chief Engineer profile for implementation and a Reviewer profile for validation only if each profile declares its respective capability. The selector MUST fail explicitly when a required capability is unavailable.

## Result control and PASS / FAIL

Worker completion is not a PASS decision. A completed work item SHALL enter validation. `PASS` SHALL require a completed validator result with no blocking findings. `FAIL` SHALL contain structured or textual findings that identify the failed acceptance criterion.

The coordinator SHALL keep the original output and every subsequent output immutable. The next iteration SHALL reference prior material rather than alter history. This makes review decisions reproducible and prevents a later agent from silently changing the recorded result.

## Iteration policy

Automatic iteration SHALL be bounded by `maxIterations`. Each iteration MUST:

1. use a new Bridge task;
2. preserve the original prompt;
3. include the prior output and `FAIL` findings as separate context; and
4. record its parent work item and iteration number.

The coordinator MUST terminate as `exhausted` when the budget is consumed. It MUST NOT retry a failed transport operation, reuse a failed task identifier, or continue after an interruption unless a future explicit resume contract is added.

## Error and compatibility model

The Orchestration Layer SHALL surface Bridge domain errors unchanged where possible. It MAY define orchestration-specific errors for agent-selection failure, invalid decision, and exhausted iteration budget. Such errors SHALL not leak AO or provider-private payloads.

If a required capability is not declared, the outcome SHALL be a compatibility failure. If a worker task ends `failed` or `interrupted`, the coordinator SHALL terminate the affected work item and MAY initiate a new bounded iteration only when policy explicitly permits that terminal state.

## Backward compatibility

This architecture is additive:

- existing Bridge HTTP endpoints and their request/response schemas SHALL remain unchanged;
- existing `TaskRequest`, `TaskHandle`, `TaskStatus`, and `TaskResult` semantics SHALL remain unchanged;
- BridgeCore SHALL remain unaware of logical agents and orchestration decisions;
- AO adapters SHALL continue to translate only AO protocol interactions; and
- callers that do not use the Orchestration Layer SHALL operate exactly as before.

## Benefits

- Keeps coordination policy out of the minimal BridgeCore.
- Enables specialised agents without coupling Bridge to a vendor or agent framework.
- Provides explicit, observable PASS/FAIL decision points.
- Makes iterations bounded and auditable.
- Supports gradual adoption: one role and one validator can be introduced first.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| The layer becomes a hidden workflow engine inside Bridge. | Keep it outside BridgeCore and depend only on public Bridge clients. |
| Unbounded cost or loops from repeated failures. | Require `maxIterations`; terminate as `exhausted`. |
| Agent selection becomes vendor-specific. | Select only from declared capabilities; prohibit name-based routing. |
| Reviewer output is ambiguous. | Require a canonical `PASS` or `FAIL` decision and actionable findings. |
| Loss of traceability between iterations. | Preserve immutable work-item records and parent references. |
| Bridge transport failures are obscured. | Propagate Bridge domain errors and do not add implicit retries. |

## Migration plan

1. **Document and contract review.** Adopt these interfaces as an external architecture only; make no Bridge API change.
2. **Single-agent pilot.** Implement one coordinator using `ChiefEngineerClient` as the `BridgeTaskClient`, with `maxIterations: 0` and no validator iteration.
3. **Validation pilot.** Add a Reviewer or Tester profile with deterministic mocked contract tests. Require `PASS` or `FAIL`, still with a bounded iteration budget.
4. **Controlled iteration.** Enable one automatic iteration only after task-history and error behavior are verified.
5. **Capability registry.** Introduce a separate, injected profile registry. BridgeCore and AO adapters remain unchanged.
6. **Operational hardening.** Add explicit observability and durable recovery only through separately approved external infrastructure; do not place them in BridgeCore.

No migration step SHALL require a change to the existing Bridge HTTP API or Agent Orchestrator API.
