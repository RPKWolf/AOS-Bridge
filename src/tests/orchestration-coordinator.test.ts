import * as assert from "node:assert/strict";
import test from "node:test";
import { CapabilityAgentSelector } from "../orchestration/agent-selector";
import type {
  BridgeTaskClient,
  DecisionAuthority,
  OrchestrationRequest,
  ResultValidator,
  ValidatedResult,
} from "../orchestration/contracts";
import { ManualDecisionAuthority } from "../orchestration/manual-decision-authority";
import { OrchestrationCoordinator } from "../orchestration/orchestration-coordinator";
import { PassResultValidator } from "../orchestration/result-validator";

const request: OrchestrationRequest = {
  id: "orchestration-1",
  prompt: "Preserve this prompt",
  requiredCapabilities: ["implementation"],
  maxIterations: 0,
};

test("selects a capable agent and submits the prompt unchanged through the injected Bridge client", async () => {
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

  assert.equal(submittedPrompt, request.prompt);
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

  assert.deepEqual(await coordinator.execute(request), {
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

  assert.deepEqual(await coordinator.execute(request), {
    id: "task-2",
    status: "completed",
    output: "revised output",
  });
  assert.deepEqual(submissions, [
    "Preserve this prompt",
    "Preserve this prompt\n\nDecision Authority findings:\n- Add tests",
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

  const result = await coordinator.execute(request);

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
  assert.deepEqual(coordinator.getOutcome(request.id).result, {
    id: "task-1",
    status: "completed",
    output: "worker output",
  });
});
