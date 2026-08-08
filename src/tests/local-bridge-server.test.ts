import * as assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { OrchestratorAdapter } from "../adapters/orchestrator-adapter";
import { BridgeCore } from "../core/bridge-core";
import { InMemoryTaskStore } from "../core/task-store";
import { LocalBridgeGateway } from "../gateway/local-bridge-gateway";
import { createLocalBridgeServer, listenOnLoopback } from "../gateway/local-bridge-server";
import type { TaskStatus } from "../types/task";

test("validates requests and serves task submit, status, and result", async () => {
  let status: TaskStatus = "running";
  const adapter: OrchestratorAdapter = {
    async submitTask() {
      return { sessionId: "session-1", turnId: "turn-1" };
    },
    async getTaskStatus() {
      return status;
    },
    async getTaskResult() {
      return { id: "task-1", status: "completed", output: "BRIDGE_OK" };
    },
  };
  const gateway = new LocalBridgeGateway(
    new BridgeCore(adapter, new InMemoryTaskStore()),
    { provider: "local-gateway", orchestrator: "agent-orchestrator" },
  );
  const server = createLocalBridgeServer(gateway);
  await listenOnLoopback(server, 0);
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const invalid = await fetch(`${baseUrl}/api/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "task-1" }),
    });
    assert.equal(invalid.status, 400);
    const invalidBody = (await invalid.json()) as { error: { code: string } };
    assert.equal(invalidBody.error.code, "INVALID_REQUEST");

    const submitted = await fetch(`${baseUrl}/api/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "task-1", prompt: "unchanged prompt" }),
    });
    assert.equal(submitted.status, 202);
    assert.deepEqual(await submitted.json(), {
      id: "task-1",
      sessionId: "session-1",
      turnId: "turn-1",
      status: "pending",
    });

    const current = await fetch(`${baseUrl}/api/v1/tasks/task-1`);
    assert.deepEqual(await current.json(), { id: "task-1", status: "running" });

    status = "completed";
    const result = await fetch(`${baseUrl}/api/v1/tasks/task-1/result`);
    assert.deepEqual(await result.json(), {
      id: "task-1",
      status: "completed",
      output: "BRIDGE_OK",
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
