import * as assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { AgentOrchestratorStub } from "../gateway/agent-orchestrator-stub";

const originalLog = console.log;

afterEach(() => {
  console.log = originalLog;
});

test("accepts a task and logs the stub marker", () => {
  const messages: string[] = [];
  console.log = (...values: unknown[]) => messages.push(String(values[0]));

  const accepted = new AgentOrchestratorStub().accept({
    id: "task-1",
    prompt: "stub task",
    provider: "local-gateway",
    orchestrator: "agent-orchestrator",
    createdAt: "2026-08-09T00:00:00.000Z",
  });

  assert.deepEqual(accepted, { status: "accepted" });
  assert.deepEqual(messages, ["Agent Orchestrator Stub"]);
});
