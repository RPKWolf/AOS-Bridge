import * as assert from "node:assert/strict";
import test from "node:test";
import { CapabilityAgentSelector } from "../orchestration/agent-selector";
import type {
  BridgeTaskClient,
  OrchestrationRequest,
  ResultValidator,
} from "../orchestration/contracts";
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

test("completes a task after the injected validator returns PASS", async () => {
  const client: BridgeTaskClient = {
    async submitTask() {
      return "task-1";
    },
    async getStatus() {
      return "completed";
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
  );

  await coordinator.start(request);

  assert.equal(await coordinator.getStatus(request.id), "completed");
  assert.deepEqual(coordinator.getOutcome(request.id).decision, {
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
