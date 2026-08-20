import * as assert from "node:assert/strict";
import test from "node:test";
import { CapabilityAgentSelector } from "../orchestration/agent-selector";
import type {
  BridgeTaskClient,
  DecisionAuthority,
  OperationVerifier,
  OrchestrationRequest,
  ResultValidator,
  ValidatedResult,
} from "../orchestration/contracts";
import { ManualDecisionAuthority } from "../orchestration/manual-decision-authority";
import { OrchestrationCoordinator } from "../orchestration/orchestration-coordinator";
import { PassResultValidator } from "../orchestration/result-validator";
import { applyWorkExecutionPolicy, WORK_EXECUTION_POLICY } from "../orchestration/work-execution-policy";

const request: OrchestrationRequest = {
  id: "orchestration-1",
  prompt: "Preserve this prompt",
  requiredCapabilities: ["implementation"],
  maxIterations: 0,
};

test("selects a capable agent and submits the policy-bound prompt through the injected Bridge client", async () => {
  let submittedPrompt: string | undefined;
  const client: BridgeTaskClient = {
    async submitTask(prompt) {
      submittedPrompt = prompt;
      return "task-1";
    },
    async getStatus() {
      return "pending";
    },
    async getResult() {
      return { id: "task-1", status: "completed" };
    },
  };
  const coordinator = new OrchestrationCoordinator(
    new CapabilityAgentSelector([
      { id: "chief-engineer", capabilities: { roles: ["implementation"], capabilities: ["implementation"] } },
    ]),
    client,
    new PassResultValidator("test-authority"),
  );

  const outcome = await coordinator.start(request);

  assert.equal(submittedPrompt, applyWorkExecutionPolicy(request.prompt));
  assert.match(submittedPrompt, /Never start a duplicate instance blindly/);
  assert.match(submittedPrompt, /IBKR execution is Paper-only/);
  assert.match(submittedPrompt, /This AO\/Codex session is the worker/);
  assert.match(submittedPrompt, /Never invoke the AO CLI/);
  assert.match(submittedPrompt, /do not fail or stop merely because a global `ao` command is absent/);
  assert.deepEqual(outcome, {
    id: "orchestration-1",
    taskId: "task-1",
    agentId: "chief-engineer",
    mode: "validated",
    status: "submitted",
  });
  assert.equal(await coordinator.getStatus(request.id), "waiting-for-work");
});

test("executes the first orchestration only after a PASS validation", async () => {
  const statuses: Array<"pending" | "running" | "completed"> = [
    "pending",
    "running",
    "completed",
  ];
  const client: BridgeTaskClient = {
    async submitTask() {
      return "task-1";
    },
    async getStatus() {
      return statuses.shift() ?? "completed";
    },
    async getResult() {
      return { id: "task-1", status: "completed", output: "unchanged output" };
    },
  };
  const coordinator = new OrchestrationCoordinator(
    new CapabilityAgentSelector([
      { id: "chief-engineer", capabilities: { roles: ["implementation"], capabilities: ["implementation"] } },
    ]),
    client,
    {
      async validate(validationRequest, validationResult) {
        assert.equal(validationRequest, request);
        assert.deepEqual(validationResult, {
          id: "task-1",
          status: "completed",
          output: "unchanged output",
        });
        return { status: "PASS", findings: [], authorityId: "human-review" };
      },
    },
    0,
  );

  const result = await coordinator.execute(request);

  assert.deepEqual(result, {
    id: "task-1",
    status: "completed",
    output: "unchanged output",
  });
  assert.equal(coordinator.getOutcome(request.id).status, "completed");
  assert.deepEqual(coordinator.getOutcome(request.id).validation, {
    status: "PASS",
    findings: [],
    authorityId: "human-review",
  });
});

test("maps failed and interrupted Bridge task statuses without retries", async () => {
  let taskStatus: "failed" | "interrupted" = "failed";
  const client: BridgeTaskClient = {
    async submitTask() {
      return "task-1";
    },
    async getStatus() {
      return taskStatus;
    },
    async getResult() {
      return { id: "task-1", status: "completed" };
    },
  };
  const selector = new CapabilityAgentSelector([
    { id: "chief-engineer", capabilities: { roles: ["implementation"], capabilities: ["implementation"] } },
  ]);
  const coordinator = new OrchestrationCoordinator(selector, client, new PassResultValidator());

  await coordinator.start(request);
  assert.equal(await coordinator.getStatus(request.id), "failed");

  const interrupted = new OrchestrationCoordinator(selector, client, new PassResultValidator());
  await interrupted.start({ ...request, id: "orchestration-2" });
  taskStatus = "interrupted";
  assert.equal(await interrupted.getStatus("orchestration-2"), "interrupted");
});

test("PassResultValidator returns an auditable PASS decision", async () => {
  const validator: ResultValidator = new PassResultValidator("mvp-authority");

  assert.deepEqual(
    await validator.validate(request, { id: "task-1", status: "completed" }),
    { status: "PASS", findings: [], authorityId: "mvp-authority" },
  );
});

test("ManualDecisionAuthority returns the supplied PASS or FAIL decision", async () => {
  const completed = { id: "task-1", status: "completed" as const };
  const validated: ValidatedResult = {
    result: completed,
    validation: { status: "PASS", findings: [], authorityId: "reviewer" },
  };
  const pass = new ManualDecisionAuthority("PASS", [], "human");
  const fail = new ManualDecisionAuthority("FAIL", ["Add test coverage"], "chatgpt");

  assert.deepEqual(await pass.decide(request, validated), {
    status: "PASS",
    findings: [],
    authorityId: "human",
  });
  assert.deepEqual(await fail.decide(request, validated), {
    status: "FAIL",
    findings: ["Add test coverage"],
    authorityId: "chatgpt",
  });
});

test("passes only the validated result to DecisionAuthority before returning an authoritative PASS", async () => {
  const client: BridgeTaskClient = {
    async submitTask() {
      return "task-1";
    },
    async getStatus() {
      return "completed";
    },
    async getResult() {
      return { id: "task-1", status: "completed", output: "final output" };
    },
  };
  let authorityInput: ValidatedResult | undefined;
  const authority: DecisionAuthority = {
    async decide(_decisionRequest, validatedResult) {
      authorityInput = validatedResult;
      return { status: "PASS", findings: [], authorityId: "human" };
    },
  };
  const coordinator = new OrchestrationCoordinator(
    new CapabilityAgentSelector([
      { id: "chief-engineer", capabilities: { roles: ["implementation"], capabilities: ["implementation"] } },
    ]),
    client,
    new PassResultValidator("reviewer"),
    0,
    authority,
  );

  assert.deepEqual(await coordinator.execute({ ...request, maxIterations: 1 }), {
    id: "task-1",
    status: "completed",
    output: "final output",
  });
  assert.deepEqual(authorityInput, {
    result: { id: "task-1", status: "completed", output: "final output" },
    validation: { status: "PASS", findings: [], authorityId: "reviewer" },
  });
});

test("creates exactly one follow-up WorkItem after FAIL and returns its PASS result", async () => {
  const submissions: string[] = [];
  const decisions = [
    { status: "FAIL" as const, findings: ["Add tests"], authorityId: "human" },
    { status: "PASS" as const, findings: [], authorityId: "human" },
  ];
  const authority: DecisionAuthority = {
    async decide() {
      const decision = decisions.shift();

      if (!decision) {
        throw new Error("Unexpected decision request");
      }

      return decision;
    },
  };
  const client: BridgeTaskClient = {
    async submitTask(prompt) {
      submissions.push(prompt);
      return `task-${submissions.length}`;
    },
    async getStatus() {
      return "completed";
    },
    async getResult(taskId) {
      return {
        id: taskId,
        status: "completed",
        output: taskId === "task-1" ? "first output" : "revised output",
      };
    },
  };
  const coordinator = new OrchestrationCoordinator(
    new CapabilityAgentSelector([
      { id: "chief-engineer", capabilities: { roles: ["implementation"], capabilities: ["implementation"] } },
    ]),
    client,
    new PassResultValidator("reviewer"),
    0,
    authority,
  );

  assert.deepEqual(await coordinator.execute({ ...request, maxIterations: 1 }), {
    id: "task-2",
    status: "completed",
    output: "revised output",
  });
  assert.deepEqual(submissions, [
    applyWorkExecutionPolicy("Preserve this prompt"),
    applyWorkExecutionPolicy("Preserve this prompt\n\nDecision Authority findings:\n- Add tests"),
  ]);
  assert.deepEqual(coordinator.getWorkItems(request.id), [
    {
      id: "orchestration-1:0",
      taskId: "task-1",
      iteration: 0,
      prompt: "Preserve this prompt",
      findings: [],
    },
    {
      id: "orchestration-1:1",
      taskId: "task-2",
      iteration: 1,
      prompt: "Preserve this prompt",
      findings: ["Add tests"],
    },
  ]);
});

test("continues corrective iterations until PASS within the configured limit", async () => {
  let submissionCount = 0;
  const decisions = ["FAIL", "FAIL", "PASS"] as const;
  let decisionIndex = 0;
  const client: BridgeTaskClient = {
    async submitTask(prompt) {
      submissionCount += 1;
      assert.match(prompt, /Mandatory execution policy/);
      return `task-${submissionCount}`;
    },
    async getStatus() {
      return "completed";
    },
    async getResult(taskId) {
      return { id: taskId, status: "completed", output: `output-${taskId}` };
    },
  };
  const authority: DecisionAuthority = {
    async decide() {
      const status = decisions[decisionIndex++];
      return { status, findings: status === "FAIL" ? [`fix-${decisionIndex}`] : [], authorityId: "reviewer" };
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
  );

  assert.deepEqual(await coordinator.execute({ ...request, maxIterations: 2 }), {
    id: "task-3",
    status: "completed",
    output: "output-task-3",
  });
  assert.equal(submissionCount, 3);
  assert.deepEqual(coordinator.getWorkItems(request.id).map((item) => item.iteration), [0, 1, 2]);
});

test("mandatory Work policy is fail-closed for Live and guards duplicate runtime starts", () => {
  assert.match(WORK_EXECUTION_POLICY, /inspect existing AOS, Immediate, Python Service, and npm runtime/);
  assert.match(WORK_EXECUTION_POLICY, /Reuse a suitable existing runtime/);
  assert.match(WORK_EXECUTION_POLICY, /start exactly one instance/);
  assert.match(WORK_EXECUTION_POLICY, /Live configuration, account, route, or ambiguity as a blocker/);
});

test("mandatory Work policy is idempotent across coordinator and Gateway boundaries", () => {
  const once = applyWorkExecutionPolicy("Implement the task");
  assert.equal(applyWorkExecutionPolicy(once), once);
  assert.equal(once.match(/AOS-BRIDGE-MANDATORY-EXECUTION-POLICY-V2/g)?.length, 1);
});

test("mandatory Work policy overrides explicit nested implementation and validation delegation", () => {
  const prompt = applyWorkExecutionPolicy(
    "Use ao to spawn a new implementation worker and then a separate validation session.",
  );

  assert.match(prompt, /Never invoke the AO CLI, spawn a nested AO worker\/session/);
  assert.match(prompt, /implementation, validation, remediation, or other AO sessions/);
  assert.match(prompt, /owned by the outer Bridge\/controller workflow/);
  assert.match(prompt, /Work request:\nUse ao to spawn/);
});

test("stops after one follow-up iteration when the second decision is FAIL", async () => {
  let submitCount = 0;
  const client: BridgeTaskClient = {
    async submitTask() {
      submitCount += 1;
      return "task-1";
    },
    async getStatus() {
      return "completed";
    },
    async getResult() {
      return { id: "task-1", status: "completed", output: "final output" };
    },
  };
  const coordinator = new OrchestrationCoordinator(
    new CapabilityAgentSelector([
      { id: "chief-engineer", capabilities: { roles: ["implementation"], capabilities: ["implementation"] } },
    ]),
    client,
    new PassResultValidator("reviewer"),
    0,
    new ManualDecisionAuthority("FAIL", ["Review rejected the output"], "human"),
  );

  const result = await coordinator.execute({ ...request, maxIterations: 1 });

  assert.deepEqual(result, {
    status: "FAIL",
    findings: ["Review rejected the output"],
    authorityId: "human",
  });
  assert.equal(submitCount, 2);
  assert.equal(coordinator.getOutcome(request.id).status, "failed");
});

test("does not return worker output or invoke DecisionAuthority when validation fails", async () => {
  let authorityCalled = false;
  const client: BridgeTaskClient = {
    async submitTask() {
      return "task-1";
    },
    async getStatus() {
      return "completed";
    },
    async getResult() {
      return { id: "task-1", status: "completed", output: "unvalidated output" };
    },
  };
  const coordinator = new OrchestrationCoordinator(
    new CapabilityAgentSelector([
      { id: "chief-engineer", capabilities: { roles: ["implementation"], capabilities: ["implementation"] } },
    ]),
    client,
    {
      async validate() {
        return { status: "FAIL", findings: ["Missing acceptance test"], authorityId: "reviewer" };
      },
    },
    0,
    {
      async decide() {
        authorityCalled = true;
        return { status: "PASS", findings: [], authorityId: "human" };
      },
    },
  );

  assert.deepEqual(await coordinator.execute(request), {
    status: "FAIL",
    findings: ["Missing acceptance test"],
    authorityId: "reviewer",
  });
  assert.equal(authorityCalled, false);
  assert.equal(coordinator.getOutcome(request.id).status, "failed");
});

test("uses explicit Pilot Mode without returning worker output when validation is disabled", async () => {
  let authorityCalled = false;
  const client: BridgeTaskClient = {
    async submitTask() {
      return "task-1";
    },
    async getStatus() {
      return "completed";
    },
    async getResult() {
      return { id: "task-1", status: "completed", output: "worker output" };
    },
  };
  const coordinator = new OrchestrationCoordinator(
    new CapabilityAgentSelector([
      { id: "chief-engineer", capabilities: { roles: ["implementation"], capabilities: ["implementation"] } },
    ]),
    client,
    undefined,
    0,
    {
      async decide() {
        authorityCalled = true;
        return { status: "PASS", findings: [], authorityId: "human" };
      },
    },
  );

  assert.deepEqual(await coordinator.execute(request), {
    mode: "pilot",
    status: "PILOT",
    findings: [
      "Pilot Mode: validation is disabled, so the worker output is not a final orchestration result.",
    ],
  });
  assert.equal(authorityCalled, false);
  assert.equal(coordinator.getOutcome(request.id).mode, "pilot");
  assert.equal(coordinator.getOutcome(request.id).status, "pilot-completed");
});

test("creates one corrective WorkItem from validator and verification findings", async () => {
  const submissions: string[] = [];
  const client: BridgeTaskClient = {
    async submitTask(prompt) {
      submissions.push(prompt);
      return `task-${submissions.length}`;
    },
    async getStatus() {
      return "completed";
    },
    async getResult(taskId) {
      return { id: taskId, status: "completed", output: taskId };
    },
  };
  const validator: ResultValidator = {
    async validate() {
      return { status: "PASS", findings: ["Validator finding"], authorityId: "reviewer" };
    },
  };
  const authority: DecisionAuthority = {
    async decide() {
      return { status: "PASS", findings: [], authorityId: "human" };
    },
  };
  const verificationResults = [
    {
      status: "FAIL" as const,
      findings: ["Verification finding"],
      evidence: ["PR was not found"],
      verifiedArtifacts: [],
      timestamp: "2026-08-11T00:00:00.000Z",
    },
    {
      status: "PASS" as const,
      findings: [],
      evidence: ["PR exists"],
      verifiedArtifacts: ["pull request:1"],
      timestamp: "2026-08-11T00:00:01.000Z",
    },
  ];
  const verifier: OperationVerifier = {
    async verify() {
      const result = verificationResults.shift();

      if (!result) {
        throw new Error("Unexpected verification request");
      }

      return result;
    },
  };
  const coordinator = new OrchestrationCoordinator(
    new CapabilityAgentSelector([
      { id: "chief-engineer", capabilities: { roles: ["implementation"], capabilities: ["implementation"] } },
    ]),
    client,
    validator,
    0,
    authority,
    verifier,
  );

  assert.deepEqual(
    await coordinator.execute({ ...request, maxIterations: 1, operationArtifacts: { pullRequest: 1 } }),
    { id: "task-2", status: "completed", output: "task-2" },
  );
  assert.equal(submissions.length, 2);
  assert.match(submissions[1], /Validator finding/);
  assert.match(submissions[1], /Verification finding/);
  assert.deepEqual(coordinator.getWorkItems(request.id)[1].findings, [
    "Validator finding",
    "Verification finding",
  ]);
});
