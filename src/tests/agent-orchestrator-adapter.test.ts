import * as assert from "node:assert/strict";
import test from "node:test";
import type { OrchestratorAdapter } from "../adapters/orchestrator-adapter";
import {
  AgentOrchestratorTimeoutError,
  AgentTaskFailedError,
  AoRequestError,
} from "../errors/bridge-error";
import { AgentOrchestratorAdapter } from "../gateway/agent-orchestrator-adapter";
import type { TaskRequest, TaskStatus } from "../types/task";

const request: TaskRequest = {
  id: "agent-task-1",
  prompt: "run task",
  provider: "local-gateway",
  orchestrator: "agent-orchestrator",
  createdAt: "2026-08-09T00:00:00.000Z",
};

test("stores the AO handle and returns the completed assistant result", async () => {
  let submitted: TaskRequest | undefined;
  const orchestrator: OrchestratorAdapter = {
    async submitTask(task) {
      submitted = task;
      return { sessionId: "session-1", turnId: "turn-1" };
    },
    async getTaskStatus() {
      return "completed";
    },
    async getTaskResult() {
      return { id: request.id, status: "completed", output: "final assistant message" };
    },
  };

  const adapter = new AgentOrchestratorAdapter(orchestrator);
  const accepted = await adapter.submitTask(request);

  assert.equal(submitted, request);
  assert.deepEqual(accepted, { taskId: "agent-task-1", status: "accepted" });
  assert.equal((await adapter.getTaskResult("agent-task-1")).output, "final assistant message");
});

test("polls pending work until it completes", async () => {
  const states: TaskStatus[] = ["pending", "completed"];
  const orchestrator: OrchestratorAdapter = {
    async submitTask() {
      return { sessionId: "session-1", turnId: "turn-1" };
    },
    async getTaskStatus() {
      return states.shift() ?? "completed";
    },
    async getTaskResult() {
      return { id: request.id, status: "completed", output: "completed after pending" };
    },
  };
  const adapter = new AgentOrchestratorAdapter(orchestrator, 100, 0);

  await adapter.submitTask(request);
  assert.equal((await adapter.waitForTaskResult("agent-task-1")).output, "completed after pending");
});

test("surfaces failed task status", async () => {
  const orchestrator: OrchestratorAdapter = {
    async submitTask() {
      return { sessionId: "session-1", turnId: "turn-1" };
    },
    async getTaskStatus() {
      return "failed";
    },
    async getTaskResult() {
      return { id: request.id, status: "completed" };
    },
  };
  const adapter = new AgentOrchestratorAdapter(orchestrator, 100, 0);

  await assert.rejects(
    (async () => {
      await adapter.submitTask(request);
      await adapter.waitForTaskResult("agent-task-1");
    })(),
    AgentTaskFailedError,
  );
});

test("surfaces a timeout without retrying", async () => {
  const orchestrator: OrchestratorAdapter = {
    async submitTask() {
      return { sessionId: "session-1", turnId: "turn-1" };
    },
    async getTaskStatus() {
      return "pending";
    },
    async getTaskResult() {
      return { id: request.id, status: "completed" };
    },
  };
  const adapter = new AgentOrchestratorAdapter(orchestrator, 1, 5);

  await assert.rejects(
    (async () => {
      await adapter.submitTask(request);
      await adapter.waitForTaskResult("agent-task-1");
    })(),
    AgentOrchestratorTimeoutError,
  );
});

test("surfaces orchestrator transport errors", async () => {
  const transportError = new AoRequestError("transport failed");
  const orchestrator: OrchestratorAdapter = {
    async submitTask() {
      return { sessionId: "session-1", turnId: "turn-1" };
    },
    async getTaskStatus() {
      throw transportError;
    },
    async getTaskResult() {
      return { id: request.id, status: "completed" };
    },
  };
  const adapter = new AgentOrchestratorAdapter(orchestrator, 100, 0);

  await adapter.submitTask(request);
  await assert.rejects(adapter.waitForTaskResult("agent-task-1"), transportError);
});
