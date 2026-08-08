import * as assert from "node:assert/strict";
import test from "node:test";
import type { OrchestratorAdapter } from "../adapters/orchestrator-adapter";
import { TaskNotCompletedError } from "../errors/bridge-error";
import { BridgeCore } from "../core/bridge-core";
import { InMemoryTaskStore } from "../core/task-store";
import type { TaskHandle, TaskRequest } from "../types/task";

const handle: TaskHandle = { sessionId: "session-1", turnId: "turn-1" };
const request: TaskRequest = {
  id: "request-1",
  prompt: "test",
  provider: "test",
  orchestrator: "test",
  createdAt: "2026-08-08T00:00:00.000Z",
};

test("stores a submitted handle and caches a completed result", async () => {
  let resultCalls = 0;
  const adapter: OrchestratorAdapter = {
    async submitTask() {
      return handle;
    },
    async getTaskStatus() {
      return "completed";
    },
    async getTaskResult() {
      resultCalls += 1;
      return { id: "request-1", status: "completed", output: "done" };
    },
  };
  const store = new InMemoryTaskStore();
  const bridge = new BridgeCore(adapter, store);

  await bridge.submitTask(request);
  assert.equal(store.get(handle)?.status, "pending");
  assert.equal((await bridge.getTaskResult(handle)).output, "done");
  assert.equal((await bridge.getTaskResult(handle)).output, "done");
  assert.equal(resultCalls, 1);
});

test("rejects result retrieval before completion", async () => {
  const adapter: OrchestratorAdapter = {
    async submitTask() {
      return handle;
    },
    async getTaskStatus() {
      return "running";
    },
    async getTaskResult() {
      return { id: "request-1", status: "completed" };
    },
  };
  const bridge = new BridgeCore(adapter);

  await assert.rejects(bridge.getTaskResult(handle), TaskNotCompletedError);
});
