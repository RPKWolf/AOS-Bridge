import * as assert from "node:assert/strict";
import test from "node:test";
import { CapabilityAgentSelector } from "../orchestration/agent-selector";
import type {
  BridgeTaskClient,
  DecisionAuthority,
  OrchestrationRequest,
  ResultValidator,
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
    status: "submitted",
  });
  assert.equal(await coordinator.getStatus(request.id), "waiting-for-work");
});

test("executes the first orchestration and returns the completed Bridge result", async () => {
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
    new PassResultValidator("human-review"),
    0,
  );

  const result = await coordinator.execute(request);

  assert.deepEqual(result, {
    id: "task-1",
    status: "completed",
    output: "unchanged output",
  });
  assert.equal(coordinator.getOutcome(request.id).status, "completed");
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
  const pass = new ManualDecisionAuthority("PASS", [], "human");
  const fail = new ManualDecisionAuthority("FAIL", ["Add test coverage"], "chatgpt");

  assert.deepEqual(await pass.decide(request, completed), {
    status: "PASS",
    findings: [],
    authorityId: "human",
  });
  assert.deepEqual(await fail.decide(request, completed), {
    status: "FAIL",
    findings: ["Add test coverage"],
    authorityId: "chatgpt",
  });
});

test("returns the Bridge result on an authoritative PASS", async () => {
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
  const coordinator = new OrchestrationCoordinator(
    new CapabilityAgentSelector([
      { id: "chief-engineer", capabilities: { roles: ["implementation"], capabilities: ["implementation"] } },
    ]),
    client,
    undefined,
    0,
    new ManualDecisionAuthority("PASS", [], "human"),
  );

  assert.deepEqual(await coordinator.execute(request), {
    id: "task-1",
    status: "completed",
    output: "final output",
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
    undefined,
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
    undefined,
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
