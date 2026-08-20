import * as assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { OrchestratorAdapter } from "../adapters/orchestrator-adapter";
import { BridgeCore } from "../core/bridge-core";
import { InMemoryTaskStore } from "../core/task-store";
import { LocalBridgeGateway } from "../gateway/local-bridge-gateway";
import { AgentOrchestratorAdapter } from "../gateway/agent-orchestrator-adapter";
import { createLocalBridgeServer, listenOnLoopback } from "../gateway/local-bridge-server";
import { AoProtocolError } from "../errors/bridge-error";
import type { TaskStatus } from "../types/task";

test("validates requests and serves task submit, status, and result", async () => {
  let status: TaskStatus = "running";
  const resolvedProjects = new Map<string, string>();
  const submittedRequests: Array<{
    prompt: string;
    routing?: { projectId?: string };
    schemaVersion?: 2;
  }> = [];
  const adapter: OrchestratorAdapter = {
    async submitTask(request) {
      submittedRequests.push(request);
      if (request.routing?.projectId === "unknown") {
        throw new AoProtocolError("AO project is not registered: unknown");
      }
      resolvedProjects.set(request.id, request.routing?.projectId ?? "only-project");
      return { sessionId: "session-1", turnId: "turn-1" };
    },
    getResolvedProjectId(taskId) {
      return resolvedProjects.get(taskId);
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
    new AgentOrchestratorAdapter(adapter),
  );
  const server = createLocalBridgeServer(gateway, { version: "1.2.3", commit: "abc1234" });
  await listenOnLoopback(server, 0);
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const control = await fetch(`${baseUrl}/control`);
    assert.equal(control.status, 200);
    assert.match(control.headers.get("content-type") ?? "", /^text\/html; charset=utf-8$/);
    const controlPage = await control.text();
    assert.match(controlPage, /<textarea id="prompt"/);
    assert.match(controlPage, /Version: <strong id="bridge-version">1\.2\.3<\/strong>/);
    assert.match(controlPage, /Commit: <strong id="bridge-commit">abc1234<\/strong>/);
    assert.match(controlPage, /Project: <strong id="bridge-project">none<\/strong>/);
    assert.match(controlPage, /Bridge status: <strong id="bridge-status">Checking…<\/strong>/);
    assert.match(controlPage, /id="project-id"/);
    assert.match(controlPage, /Current task:/);
    assert.match(controlPage, /id="heartbeat"/);
    assert.match(controlPage, /id="poll-count"/);
    assert.match(controlPage, /transition:/);
    assert.match(controlPage, /— active/);

    const accepted = await fetch(`${baseUrl}/api/v1/agent-task`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "stub task" }),
    });
    assert.equal(accepted.status, 202);
    const acceptedBody = (await accepted.json()) as { taskId: string; status: string };
    assert.match(acceptedBody.taskId, /^agent-task-\d+$/);
    assert.equal(acceptedBody.status, "accepted");
    assert.match(submittedRequests.at(-1)?.prompt ?? "", /This AO\/Codex session is the worker/);
    assert.match(submittedRequests.at(-1)?.prompt ?? "", /Work request:\nstub task/);

    const agentStatus = await fetch(`${baseUrl}/api/v1/tasks/${acceptedBody.taskId}`);
    assert.deepEqual(await agentStatus.json(), { id: acceptedBody.taskId, status: "running" });

    status = "completed";
    const agentResult = await fetch(`${baseUrl}/api/v1/tasks/${acceptedBody.taskId}/result`);
    assert.deepEqual(await agentResult.json(), {
      id: acceptedBody.taskId,
      status: "completed",
      output: "BRIDGE_OK",
    });

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
    assert.equal(submittedRequests.at(-1)?.routing, undefined);
    assert.match(submittedRequests.at(-1)?.prompt ?? "", /Work request:\nunchanged prompt/);

    const routed = await fetch(`${baseUrl}/api/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: 2,
        id: "task-routed",
        prompt: "unchanged routed prompt",
        routing: { projectId: "aos" },
      }),
    });
    assert.equal(routed.status, 202);
    assert.deepEqual(submittedRequests.at(-1)?.routing, { projectId: "aos" });
    assert.equal(submittedRequests.at(-1)?.schemaVersion, 2);
    assert.match(
      submittedRequests.at(-1)?.prompt ?? "",
      /Bridge already resolved and validated the AO project/,
    );

    const routedControl = await (await fetch(`${baseUrl}/control`)).text();
    assert.match(routedControl, /Project: <strong id="bridge-project">aos<\/strong>/);

    const rejected = await fetch(`${baseUrl}/api/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: 2,
        id: "task-unknown",
        prompt: "must fail closed",
        routing: { projectId: "unknown" },
      }),
    });
    assert.equal(rejected.status, 502);
    const controlAfterRejectedRouting = await (await fetch(`${baseUrl}/control`)).text();
    assert.match(controlAfterRejectedRouting, /Project: <strong id="bridge-project">aos<\/strong>/);

    status = "running";
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
