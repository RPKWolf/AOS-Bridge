import * as assert from "node:assert/strict";
import test from "node:test";
import { CapabilityAgentSelector } from "../orchestration/agent-selector";
import type {
  BridgeTaskClient,
  ChiefEngineerContinuationPolicy,
  ChiefEngineerDecision,
  DecisionAuthority,
  OrchestrationRequest,
} from "../orchestration/contracts";
import { OrchestrationCoordinator } from "../orchestration/orchestration-coordinator";
import { PassResultValidator } from "../orchestration/result-validator";

const baseRequest: OrchestrationRequest = {
  id: "continuation-1",
  prompt: "Implement the approved objective",
  requiredCapabilities: ["implementation"],
  maxIterations: 0,
  maxContinuations: 1,
};

const review = {
  proven: ["Result and evidence were read"],
  rootCause: ["Missing follow-up phase"],
  fixed: ["Current phase completed"],
  tests: ["Tests passed"],
  unresolved: ["Follow-up remains"],
  newProblems: [],
};

function decision(action: ChiefEngineerDecision["action"], overrides = {}): ChiefEngineerDecision {
  return {
    action,
    review,
    nextStep: "Run the approved follow-up",
    reason: "It is safe, deterministic, and remains in scope",
    ...(action === "CONTINUE" ? { continuationAttestations: {
      safety: { preserved: true, evidence: "No safety boundary changes" },
      scope: { preserved: true, evidence: "The next phase remains within the approved objective" },
      risk: { preserved: true, evidence: "Risk is unchanged" },
    } } : {}),
    ...overrides,
  };
}

function harness(
  policy: ChiefEngineerContinuationPolicy,
  authority?: DecisionAuthority,
  outputs: readonly string[] = ["phase one", "phase two"],
) {
  const submissions: string[] = [];
  let resultIndex = 0;
  const client: BridgeTaskClient = {
    async submitTask(prompt) {
      submissions.push(prompt);
      return `task-${submissions.length}`;
    },
    async getStatus() { return "completed"; },
    async getResult(taskId) {
      return { id: taskId, status: "completed", output: outputs[resultIndex++] ?? "done" };
    },
  };
  const coordinator = new OrchestrationCoordinator(
    new CapabilityAgentSelector([
      { id: "chief-engineer", capabilities: { roles: ["implementation"], capabilities: ["implementation"] } },
    ]),
    client,
    new PassResultValidator("validator"),
    0,
    authority,
    undefined,
    policy,
    () => "2026-08-12T12:00:00.000Z",
  );
  return { coordinator, submissions };
}

test("PASS with a safe unambiguous next step automatically continues through Bridge", async () => {
  const reviews = [
    decision("CONTINUE", { nextPrompt: "Execute phase two" }),
    decision("COMPLETE", { nextStep: "No further work is required", reason: "Objective is complete" }),
  ];
  const { coordinator, submissions } = harness({ async review() { return reviews.shift()!; } });

  assert.deepEqual(await coordinator.execute(baseRequest), {
    id: "task-2", status: "completed", output: "phase two",
  });
  assert.equal(submissions.length, 2);
  assert.match(submissions[1], /Execute phase two/);
  assert.match(submissions[1], /Mandatory execution policy/);
  assert.deepEqual(coordinator.getWorkItems(baseRequest.id).map((item) => item.kind), [undefined, "continuation"]);
});

test("FAIL corrective iteration then PASS is reviewed and may continue", async () => {
  const authorityDecisions = ["FAIL", "PASS", "PASS"] as const;
  let authorityIndex = 0;
  const chiefDecisions = [
    decision("CONTINUE", { nextPrompt: "Run the next safe phase" }),
    decision("COMPLETE", { nextStep: "Close objective", reason: "All phases passed" }),
  ];
  const { coordinator, submissions } = harness(
    { async review() { return chiefDecisions.shift()!; } },
    { async decide() {
      const status = authorityDecisions[authorityIndex++];
      return { status, findings: status === "FAIL" ? ["Correct defect"] : [], authorityId: "reviewer" };
    } },
    ["bad", "corrected", "continued"],
  );

  const result = await coordinator.execute({ ...baseRequest, maxIterations: 1 });
  assert.equal(result.status, "completed");
  assert.equal(submissions.length, 3);
  assert.match(submissions[1], /Correct defect/);
  assert.match(submissions[2], /Run the next safe phase/);
});

for (const scenario of [
  { name: "safety blocker", action: "USER_DECISION_REQUIRED" as const,
    reason: "Live route ambiguity is a safety blocker", question: "Keep execution Paper-only?" },
  { name: "scope and risk boundary", action: "USER_DECISION_REQUIRED" as const,
    reason: "The next phase changes risk scope", question: "Approve the expanded risk scope?" },
  { name: "technical blocker without a safe resolution", action: "BLOCKED" as const,
    reason: "Required upstream API is unavailable", question: undefined },
]) {
  test(`${scenario.name} stops automatic continuation`, async () => {
    const policy: ChiefEngineerContinuationPolicy = { async review() {
      return decision(scenario.action, {
        reason: scenario.reason,
        nextStep: "Wait for an explicit resolution",
        question: scenario.question,
        recommendedOption: scenario.question ? "Do not expand scope; remain Paper-only" : undefined,
      });
    } };
    const { coordinator, submissions } = harness(policy);
    const result = await coordinator.execute(baseRequest);
    assert.equal(result.status, scenario.action);
    assert.equal(submissions.length, 1);
    assert.equal(coordinator.getOutcome(baseRequest.id).status,
      scenario.action === "USER_DECISION_REQUIRED" ? "awaiting-decision" : "blocked");
  });
}

test("continuation limit terminates safely with exact state and recommendation", async () => {
  const { coordinator, submissions } = harness({ async review() {
    return decision("CONTINUE", { nextPrompt: "Another safe phase" });
  } });
  const result = await coordinator.execute(baseRequest);
  assert.deepEqual(result, {
    status: "LIMIT_REACHED",
    reason: "Continuation limit 1 reached.",
    nextStep: "Run the approved follow-up",
    question: undefined,
    recommendedOption: undefined,
  });
  assert.equal(submissions.length, 2);
  assert.equal(coordinator.getOutcome(baseRequest.id).status, "continuation-limit-reached");
});

test("a real exhausted technical FAIL is reviewed and stops without unsafe continuation", async () => {
  let reviewedStatus: string | undefined;
  const { coordinator, submissions } = harness(
    { async review(context) {
      reviewedStatus = context.result.status;
      return decision("BLOCKED", {
        reason: "The technical blocker has no safe automated resolution",
        nextStep: "Restore the unavailable dependency",
      });
    } },
    { async decide() {
      return { status: "FAIL", findings: ["Dependency unavailable"], authorityId: "reviewer" };
    } },
  );
  const result = await coordinator.execute({ ...baseRequest, maxIterations: 0 });
  assert.equal(reviewedStatus, "FAIL");
  assert.equal(result.status, "BLOCKED");
  assert.equal(submissions.length, 1);
});

test("rejects an invalid continuation budget before submitting work", async () => {
  const { coordinator, submissions } = harness({ async review() { return decision("COMPLETE"); } });
  await assert.rejects(
    coordinator.execute({ ...baseRequest, maxContinuations: -1 }),
    /maxContinuations must be a non-negative integer/,
  );
  assert.equal(submissions.length, 0);
});

test("audit history records every Chief Engineer decision and its reason", async () => {
  const decisions = [
    decision("CONTINUE", { nextPrompt: "Phase two" }),
    decision("COMPLETE", { reason: "Evidence proves the objective is complete", nextStep: "Close" }),
  ];
  const { coordinator } = harness({ async review() { return decisions.shift()!; } });
  await coordinator.execute(baseRequest);
  const history = coordinator.getChiefEngineerHistory(baseRequest.id);
  assert.deepEqual(history.map(({ action, reason, taskId, timestamp }) => ({ action, reason, taskId, timestamp })), [
    { action: "CONTINUE", reason: "It is safe, deterministic, and remains in scope", taskId: "task-1", timestamp: "2026-08-12T12:00:00.000Z" },
    { action: "COMPLETE", reason: "Evidence proves the objective is complete", taskId: "task-2", timestamp: "2026-08-12T12:00:00.000Z" },
  ]);
  assert.deepEqual(history[0].review, review);
});

test("policy rejection fails closed with an audited stop", async () => {
  const { coordinator, submissions } = harness({ async review() {
    throw new Error("review service unavailable");
  } });
  const result = await coordinator.execute(baseRequest);
  assert.equal(result.status, "BLOCKED");
  assert.match(result.reason, /failed closed: review service unavailable/);
  assert.equal(submissions.length, 1);
  assert.equal(coordinator.getOutcome(baseRequest.id).status, "blocked");
  assert.deepEqual(coordinator.getChiefEngineerHistory(baseRequest.id).map(({ action, reason }) =>
    ({ action, reason })), [{ action: "BLOCKED", reason: result.reason }]);
});

test("missing or negative boundary attestations stop before continuation submit", async () => {
  for (const continuationAttestations of [undefined, {
    safety: { preserved: true, evidence: "safe" },
    scope: { preserved: true, evidence: "in scope" },
    risk: { preserved: false, evidence: "risk changed" },
  }]) {
    const { coordinator, submissions } = harness({ async review() {
      return decision("CONTINUE", { nextPrompt: "Unsafe phase", continuationAttestations });
    } });
    const result = await coordinator.execute({ ...baseRequest, id: `attestation-${String(continuationAttestations)}` });
    assert.equal(result.status, "BLOCKED");
    assert.match(result.reason, /failed closed/);
    assert.equal(submissions.length, 1);
  }
});

test("each review receives the active continuation request", async () => {
  const prompts: string[] = [];
  const decisions = [
    decision("CONTINUE", { nextPrompt: "Execute phase two" }),
    decision("CONTINUE", { nextPrompt: "Execute phase three" }),
    decision("COMPLETE"),
  ];
  const { coordinator } = harness({ async review(context) {
    prompts.push(context.request.prompt);
    return decisions.shift()!;
  } }, undefined, ["one", "two", "three"]);
  await coordinator.execute({ ...baseRequest, maxContinuations: 2 });
  assert.deepEqual(prompts, [baseRequest.prompt, "Execute phase two", "Execute phase three"]);
});

test("external callers cannot mutate nested Chief Engineer audit state", async () => {
  const firstDecision = decision("CONTINUE", { nextPrompt: "Phase two" });
  const decisions = [firstDecision, decision("COMPLETE")];
  const { coordinator } = harness({ async review() { return decisions.shift()!; } });
  await coordinator.execute(baseRequest);
  (firstDecision.review.proven as string[])[0] = "policy tampered";
  firstDecision.continuationAttestations!.safety.evidence = "policy tampered";
  const exposed = coordinator.getChiefEngineerHistory(baseRequest.id) as unknown as ChiefEngineerDecision[];
  (exposed[0].review.proven as string[])[0] = "tampered";
  exposed[0].continuationAttestations!.safety.evidence = "tampered";
  exposed.splice(1, 1);
  const internal = coordinator.getChiefEngineerHistory(baseRequest.id);
  assert.equal(internal.length, 2);
  assert.equal(internal[0].review.proven[0], "Result and evidence were read");
  assert.equal(internal[0].continuationAttestations!.safety.evidence, "No safety boundary changes");
});
