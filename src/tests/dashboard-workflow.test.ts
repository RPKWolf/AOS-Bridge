import * as assert from "node:assert/strict";
import test from "node:test";
import type { OrchestratorAdapter } from "../adapters/orchestrator-adapter";
import { AgentOrchestratorAdapter } from "../gateway/agent-orchestrator-adapter";
import {
  DashboardWorkflowCoordinator,
  type DashboardWorkflowRequest,
} from "../orchestration/dashboard-workflow";
import type { TaskRequest } from "../types/task";

const BASE = "1111111111111111111111111111111111111111";
const IMPLEMENTED = "2222222222222222222222222222222222222222";
const REMEDIATED = "3333333333333333333333333333333333333333";

test("implementation returns a commit and validation PASS closes in a new exact-commit session", async () => {
  const harness = createHarness([
    phase("implementation", "PASS", { baseCommit: BASE, commit: IMPLEMENTED }),
    phase("validation", "PASS", { targetCommit: IMPLEMENTED }),
  ]);

  const outcome = await harness.coordinator.run(workflow());

  assert.equal(outcome.status, "PASS");
  assert.equal(outcome.commit, IMPLEMENTED);
  assert.deepEqual(harness.sessions, ["session-1", "session-2"]);
  assert.equal(new Set(harness.sessions).size, 2);
  assert.deepEqual(harness.requests.map((item) => item.routing), [
    { projectId: "aos-dashboard" }, { projectId: "aos-dashboard" },
  ]);
  assert.equal(harness.requests[0].metadata?.baseCommit, BASE);
  assert.equal(harness.requests[1].metadata?.targetCommit, IMPLEMENTED);
  assert.match(harness.requests[1].prompt, new RegExp(`checkout and verify exactly that commit`));
  assert.doesNotMatch(harness.requests.map((item) => item.prompt).join("\n"), /restore|resume/i);
});

test("validation FAIL creates new remediation and then new validation sessions", async () => {
  const harness = createHarness([
    phase("implementation", "PASS", { baseCommit: BASE, commit: IMPLEMENTED }),
    phase("validation", "FAIL", { targetCommit: IMPLEMENTED, failureSignature: "layout-1", findings: ["mobile layout"] }),
    phase("remediation", "PASS", { baseCommit: IMPLEMENTED, commit: REMEDIATED }),
    phase("validation", "PASS", { targetCommit: REMEDIATED }),
  ]);

  const outcome = await harness.coordinator.run(workflow({ maxRemediations: 1 }));

  assert.equal(outcome.status, "PASS");
  assert.equal(outcome.commit, REMEDIATED);
  assert.deepEqual(harness.sessions, ["session-1", "session-2", "session-3", "session-4"]);
  assert.deepEqual(harness.requests.map((item) => item.metadata?.phase), [
    "implementation", "validation", "remediation", "validation",
  ]);
  assert.equal(harness.requests[2].metadata?.baseCommit, IMPLEMENTED);
  assert.equal(harness.requests[3].metadata?.targetCommit, REMEDIATED);
});

test("bounded remediation loop fails closed", async () => {
  const harness = createHarness([
    phase("implementation", "PASS", { baseCommit: BASE, commit: IMPLEMENTED }),
    phase("validation", "FAIL", { targetCommit: IMPLEMENTED, failureSignature: "first" }),
  ]);
  const outcome = await harness.coordinator.run(workflow({ maxRemediations: 0 }));
  assert.equal(outcome.status, "FAIL");
  assert.equal(outcome.reason, "Remediation limit exhausted");
  assert.equal(harness.requests.length, 2);
});

test("duplicate validation failure fails closed without another remediation", async () => {
  const harness = createHarness([
    phase("implementation", "PASS", { baseCommit: BASE, commit: IMPLEMENTED }),
    phase("validation", "FAIL", { targetCommit: IMPLEMENTED, failureSignature: "same" }),
    phase("remediation", "PASS", { baseCommit: IMPLEMENTED, commit: REMEDIATED }),
    phase("validation", "FAIL", { targetCommit: REMEDIATED, failureSignature: "same" }),
  ]);
  const outcome = await harness.coordinator.run(workflow({ maxRemediations: 2 }));
  assert.equal(outcome.status, "FAIL");
  assert.equal(outcome.reason, "Validation repeated the same failure");
  assert.equal(harness.requests.length, 4);
});

test("mismatch, unknown commit, and incomplete output fail closed", async (t) => {
  await t.test("project mismatch", async () => {
    const harness = createHarness([
      JSON.stringify({ phase: "implementation", status: "PASS", projectId: "wrong", baseCommit: BASE, commit: IMPLEMENTED }),
    ]);
    assert.match((await harness.coordinator.run(workflow())).reason ?? "", /projectId mismatch/);
  });
  await t.test("unknown commit reported by validation", async () => {
    const harness = createHarness([
      phase("implementation", "PASS", { baseCommit: BASE, commit: IMPLEMENTED }),
      phase("validation", "FAIL", { targetCommit: IMPLEMENTED, failureCode: "UNKNOWN_COMMIT", failureSignature: "unknown-commit", findings: ["commit does not exist"] }),
    ]);
    const outcome = await harness.coordinator.run(workflow({ maxRemediations: 2 }));
    assert.equal(outcome.status, "FAIL");
    assert.equal(outcome.reason, "Validation failed closed: UNKNOWN_COMMIT");
    assert.equal(harness.requests.length, 2);
  });
  await t.test("commit mismatch", async () => {
    const harness = createHarness([
      phase("implementation", "PASS", { baseCommit: BASE, commit: IMPLEMENTED }),
      phase("validation", "PASS", { targetCommit: REMEDIATED }),
    ]);
    assert.match((await harness.coordinator.run(workflow())).reason ?? "", /commit mismatch/);
  });
  await t.test("incomplete result", async () => {
    const harness = createHarness([JSON.stringify({ phase: "implementation", status: "PASS", projectId: "aos-dashboard" })]);
    assert.match((await harness.coordinator.run(workflow())).reason ?? "", /commit mismatch|did not return PASS/);
  });
  await t.test("nonexistent SHA shape", async () => {
    const outcome = await createHarness([]).coordinator.run(workflow({ baseCommit: "main" }));
    assert.match(outcome.reason ?? "", /full lowercase 40-character commit SHA/);
  });
});

function createHarness(outputs: string[]) {
  const requests: TaskRequest[] = [];
  const sessions: string[] = [];
  const outputByTurn = new Map<string, string>();
  const orchestrator: OrchestratorAdapter = {
    async submitTask(request) {
      requests.push(request);
      const sequence = requests.length;
      const sessionId = `session-${sequence}`;
      const turnId = `turn-${sequence}`;
      sessions.push(sessionId);
      outputByTurn.set(turnId, outputs.shift() ?? "{}");
      return { sessionId, turnId };
    },
    async getTaskStatus() { return "completed"; },
    async getTaskResult(handle) {
      return { id: handle.turnId, status: "completed", output: outputByTurn.get(handle.turnId) };
    },
  };
  const client = new AgentOrchestratorAdapter(orchestrator, 100, 0);
  return {
    coordinator: new DashboardWorkflowCoordinator(client, "test", "ao", () => "correlation-1"),
    requests,
    sessions,
  };
}

function workflow(overrides: Partial<DashboardWorkflowRequest> = {}): DashboardWorkflowRequest {
  return {
    id: "dashboard-11",
    projectId: "aos-dashboard",
    baseCommit: BASE,
    prompt: "Implement dashboard task",
    maxRemediations: 1,
    ...overrides,
  };
}

function phase(
  phaseName: "implementation" | "validation" | "remediation",
  status: "PASS" | "FAIL",
  fields: Record<string, unknown>,
): string {
  return JSON.stringify({ phase: phaseName, status, projectId: "aos-dashboard", findings: [], ...fields });
}
