import * as assert from "node:assert/strict";
import test from "node:test";
import type { OrchestratorAdapter } from "../adapters/orchestrator-adapter";
import {
  AgentOrchestratorTimeoutError,
  AoRequestError,
} from "../errors/bridge-error";
import { AgentOrchestratorAdapter } from "../gateway/agent-orchestrator-adapter";
import type { TaskRequest } from "../types/task";

const request: TaskRequest = {
  id: "agent-task-1",
  prompt: "run task",
  provider: "local-gateway",
  orchestrator: "agent-orchestrator",
  createdAt: "2026-08-09T00:00:00.000Z",
};

test("submits through the orchestrator and returns accepted", async () => {
  let submitted: TaskRequest | undefined;
  const orchestrator: OrchestratorAdapter = {
    async submitTask(task) {
      submitted = task;
      return { sessionId: "session-1", turnId: "turn-1" };
    },
    async getTaskStatus() {
      return "pending";
    },
    async getTaskResult() {
      return { id: request.id, status: "completed" };
    },
  };

  const accepted = await new AgentOrchestratorAdapter(orchestrator).submitTask(request);

  assert.equal(submitted, request);
  assert.deepEqual(accepted, { taskId: "agent-task-1", status: "accepted" });
});

test("surfaces orchestrator transport errors", async () => {
  const transportError = new AoRequestError("transport failed");
  const orchestrator: OrchestratorAdapter = {
    async submitTask() {
      throw transportError;
    },
    async getTaskStatus() {
      return "pending";
    },
    async getTaskResult() {
      return { id: request.id, status: "completed" };
    },
  };

  await assert.rejects(
    new AgentOrchestratorAdapter(orchestrator).submitTask(request),
    transportError,
  );
});

test("surfaces a timeout without retrying", async () => {
  const orchestrator: OrchestratorAdapter = {
    async submitTask() {
      return new Promise(() => undefined);
    },
    async getTaskStatus() {
      return "pending";
    },
    async getTaskResult() {
      return { id: request.id, status: "completed" };
    },
  };

  await assert.rejects(
    new AgentOrchestratorAdapter(orchestrator, 1).submitTask(request),
    AgentOrchestratorTimeoutError,
  );
});
