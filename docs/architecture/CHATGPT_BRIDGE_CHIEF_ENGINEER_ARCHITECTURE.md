# ChatGPT → AOS-Bridge → Chief Engineer Architecture

**Status:** Proposed architecture

## 1. Purpose

This document defines the final interaction layer in which the user talks only to ChatGPT. ChatGPT prepares the work request, submits it to AOS-Bridge, observes it, reviews the completed work, and returns either a final result or an explicit request for a human decision.

The Bridge remains a transport boundary. BridgeCore, the Agent Orchestrator API, and the existing Bridge HTTP API SHALL remain unchanged. The `/control` page is not part of this flow and SHALL NOT be required for task submission or review.

## 2. Feasibility classification

### IMPLEMENTABLE NOW

- Existing AOS-Bridge task submission, status, and result endpoints can transport a task from an authorised client to Chief Engineer.
- The existing Orchestration Layer can select the Chief Engineer profile, execute one bounded follow-up iteration after an authoritative `FAIL`, and retain process-local WorkItems.
- ChatGPT can prepare a bounded work specification and produce a structured review decision in the conversation.
- A local component that runs in the same trusted host context as Bridge can use the existing Bridge API without changing it.

### REQUIRES PLATFORM SUPPORT

- A cloud-hosted ChatGPT conversation directly calling `http://127.0.0.1:8787` on the user's machine. The local address resolves in the caller's network namespace, not as a safe, authenticated bridge from the hosted ChatGPT service to the user's loopback process.
- An approved ChatGPT desktop connector/action that can reach a user-authorised loopback service, bind that authority to a local user session, and expose only an allowlisted action surface.
- Durable autonomous polling after the ChatGPT interaction has ended. The architecture MUST NOT assume that a ChatGPT turn continues running in the background or will resume without an explicit platform lifecycle contract.
- Automatic use of a remote custom action against Bridge. This would require a supported, externally reachable and authenticated action endpoint; Bridge is intentionally loopback-only and this design MUST NOT make it public merely to satisfy an integration.

ChatGPT external-action availability and user/workspace controls are platform-dependent. This proposal therefore treats direct ChatGPT-to-loopback transport as a platform boundary, not as an AOS-Bridge feature. The [OpenAI API tool model](https://platform.openai.com/docs/quickstart/make-your-first-api-request) is the relevant official integration baseline.

## 3. Architectural boundary

```text
User
  |
  v
ChatGPT Conversation and Decision Authority
  |
  | approved local connector / broker (platform capability)
  v
ChatGPT Bridge Client
  |
  | existing Bridge HTTP API; no new endpoint
  v
AOS-Bridge Transport Layer
  |
  v
Orchestration Layer
  |
  v
Chief Engineer profile -> BridgeCore -> AO adapter -> Agent Orchestrator
```

ChatGPT SHALL be the sole user-facing client. The user MUST NOT submit prompts through a Bridge UI. A local connector or broker, if provided by the platform, is a transport conduit only; it MUST NOT interpret prompts, make product decisions, or call AO directly.

## 4. Components

### ChatGPT Conversation Controller

The Conversation Controller SHALL:

- collect the user's intent and acceptance criteria;
- create a bounded `WorkSpecification`;
- request user clarification when requirements are incomplete or an irreversible decision needs approval;
- submit the specification through `ChatGPTBridgeClient`;
- interpret task progress for the user without altering Bridge statuses;
- review a completed output against the original acceptance criteria; and
- act as a Decision Authority only when it is explicitly configured to do so.

It MUST NOT call AO, access BridgeCore, invent an unverified task result, or claim that a background task is being observed when the platform has not granted an active connector session.

### ChatGPT Bridge Client

`ChatGPTBridgeClient` SHALL be the only component allowed to invoke the existing Bridge API on behalf of ChatGPT. It SHALL use the current task submission, status, and result contracts exactly as defined by Bridge.

It MUST NOT expose `AO_BASE_URL`, AO project identifiers, harnesses, display names, AO handles, or local process credentials to ChatGPT. It MUST NOT add an endpoint or change a Bridge response schema.

### Local Connector / Access Broker

The Local Connector is **REQUIRES PLATFORM SUPPORT**. If made available, it SHALL terminate the platform-to-local transport and enforce user consent, origin binding, action allowlisting, and least-privilege credentials before forwarding a request to `127.0.0.1`.

The broker MUST NOT listen on a public interface, tunnel the Bridge without explicit user approval, or become a second orchestration engine. It SHALL forward only the existing permitted Bridge API operations.

### Orchestration Layer

The Orchestration Layer SHALL continue to select the Chief Engineer profile and execute the bounded lifecycle. It remains independent of ChatGPT and only receives Bridge task work through its existing injected contracts.

It MUST NOT receive ChatGPT secrets, conversation session tokens, or provider-specific objects. It MUST NOT make architectural or product decisions; it executes an explicit `DecisionResult` only.

### Chief Engineer

Chief Engineer is a logical agent profile selected through declared capabilities. It receives the original work prompt through Bridge and returns its backend output unchanged. Chief Engineer is not a ChatGPT client and MUST NOT communicate with the user directly.

## 5. Contracts

The following are proposed client-side contracts. They are architectural only and SHALL NOT alter Bridge HTTP or AO contracts.

```ts
interface WorkSpecification {
  readonly id: string;
  readonly prompt: string;
  readonly acceptanceCriteria: readonly string[];
  readonly requiredCapabilities: readonly string[];
}

interface ChatGPTBridgeClient {
  submitTask(specification: WorkSpecification): Promise<{ taskId: string }>;
  getStatus(taskId: string): Promise<TaskStatus>;
  getResult(taskId: string): Promise<TaskResult>;
}

interface ChatGPTDecisionAuthority {
  review(
    specification: WorkSpecification,
    result: TaskResult,
  ): Promise<DecisionResult | DecisionRequest>;
}

interface DecisionRequest {
  readonly kind: "human-decision-required";
  readonly question: string;
  readonly options: readonly string[];
  readonly reason: string;
}
```

`TaskStatus`, `TaskResult`, and `DecisionResult` retain their existing meanings. A `WorkSpecification` is created outside Bridge; `prompt` is forwarded unchanged to the first WorkItem. Review findings are attached only to the existing bounded follow-up context defined by the Orchestration Layer.

## 6. Communication flow

1. The user provides an objective only in ChatGPT.
2. ChatGPT creates a `WorkSpecification` with explicit acceptance criteria or asks the user to clarify it.
3. Through the approved local connector, `ChatGPTBridgeClient` submits the unchanged task using the existing Bridge API.
4. Bridge transports the task to Chief Engineer through the existing Orchestration Layer, BridgeCore, and AO adapter boundaries.
5. ChatGPT obtains the canonical Bridge status while an active connector session is available.
6. On `completed`, ChatGPT obtains the unchanged `TaskResult.output`.
7. ChatGPT reviews the output and produces one of:
   - `PASS`: the workflow closes and ChatGPT returns only the final output or a concise result summary requested by the user;
   - `FAIL`: findings are supplied to the existing Orchestration Layer, which creates exactly one new WorkItem and reuses the original prompt plus separate findings context; or
   - `human-decision-required`: ChatGPT stops and asks the user a focused question. No follow-up WorkItem is created until the user supplies a decision.
8. After the one allowed follow-up completes, ChatGPT reviews it once more. `PASS` closes the workflow; `FAIL` returns the decision and findings to the user. No third iteration is created.

## 7. Iteration control

The iteration budget SHALL be one follow-up WorkItem at most. ChatGPT MUST NOT issue a new task on every review attempt, retry a transport error, or bypass the Orchestration Layer to create a second iteration.

The original prompt SHALL remain immutable in the WorkSpecification and in every WorkItem. A FAIL finding SHALL be represented as separate context for the second task. The audit trail SHALL record both the original prompt reference and the findings reference.

If ChatGPT cannot make a safe review decision because acceptance criteria are missing, conflicting, or require a product/architecture choice, it SHALL emit `human-decision-required`. It MUST NOT convert uncertainty into `PASS` or `FAIL`.

## 8. Errors and terminal states

| Condition | Required behavior |
| --- | --- |
| Bridge task is `pending` or `running` | Report the canonical status only while an active connector session exists. |
| Bridge task is `completed` | Retrieve the existing result and begin review. |
| Bridge task is `failed` or `interrupted` | Return the terminal state and available domain error context; do not retry. |
| Bridge transport error | Propagate the Bridge domain error. Do not reinterpret it as a Chief Engineer failure. |
| Connector unavailable or user consent expired | Stop observation and state that live local access is unavailable. This is not a task failure. |
| ChatGPT review is uncertain | Return `human-decision-required`; do not submit an iteration. |
| Follow-up review is `FAIL` | Return the findings and final decision to the user; do not create a third WorkItem. |

## 9. Security

- Bridge SHALL remain bound to `127.0.0.1`; this architecture MUST NOT expose it on `0.0.0.0`.
- ChatGPT MUST NOT receive AO configuration, AO credentials, or a raw Bridge control URL usable outside the approved connector scope.
- The connector SHALL require explicit user consent for each capability grant or an equivalent platform-managed consent record.
- The connector SHALL use a short-lived, local, audience-bound credential and SHALL allowlist only the existing task operations it needs.
- Prompts and results MAY contain sensitive material. The user SHALL be told that data sent through a ChatGPT connector is subject to the relevant ChatGPT and workspace data controls.
- The connector MUST validate response origin and task correlation identifiers. It MUST reject cross-user task access.
- No component SHALL use a public tunnel, browser automation, shared local token, or undocumented AO route as a substitute for approved platform support.

## 10. Audit

The control plane SHALL create an immutable audit record per orchestration containing:

- a correlation identifier linking the ChatGPT interaction, Bridge task, and WorkItems;
- the selected Chief Engineer profile identifier;
- status observations with timestamps;
- the Decision Authority identity (`chatgpt`, `human`, or another explicit identifier);
- each `PASS`, `FAIL`, or `human-decision-required` decision;
- findings references and the decision that authorised the follow-up; and
- the final terminal outcome.

Audit records MUST NOT include AO credentials, connector secrets, or unnecessary raw conversation history. Retention, export, and redaction policy are outside the Bridge MVP and require an explicit future authority.

## 11. Limitations

- This design does not implement a new Bridge endpoint, server, connector, web UI, or ChatGPT integration.
- A normal hosted ChatGPT conversation cannot be assumed to reach a local loopback-only Bridge or continue polling after the turn ends. Both require an approved platform capability.
- The existing Orchestration Layer supports one sequential follow-up only. There is no parallel work, persistence, retry policy, streaming, scheduler, or queue.
- ChatGPT review is a decision aid, not a substitute for a required human product or architecture decision.

## 12. Adoption path

1. Keep `/control` available only as a development diagnostic; stop documenting it as the user workflow.
2. Define and obtain approved platform support for the Local Connector, including loopback reachability, consent, and credential handling.
3. Configure ChatGPT as the sole user-facing client with a strict `WorkSpecification` and `DecisionResult` schema.
4. Pilot task submission and active-session status observation without automatic follow-up.
5. Enable one authoritative FAIL → follow-up path and verify the audit trail.
6. Enable human decision escalation before allowing any broader automation.

No step in this path SHALL modify BridgeCore, the Agent Orchestrator API, or the existing Bridge HTTP API.
