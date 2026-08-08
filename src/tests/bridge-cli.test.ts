import * as assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { runLocalCli } from "../cli/bridge-cli";

const originalFetch = globalThis.fetch;
const originalLog = console.log;
const originalNow = Date.now;

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  Date.now = originalNow;
});

test("submits and reads a completed task through the local HTTP API", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const output: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });

    if (url.endsWith("/api/v1/tasks")) {
      return Response.json({ id: "task-1", status: "pending" }, { status: 202 });
    }
    if (url.endsWith("/api/v1/tasks/task-1")) {
      return Response.json({ id: "task-1", status: "completed" });
    }

    return Response.json({ id: "task-1", status: "completed", output: "BRIDGE_OK" });
  };
  Date.now = () => 0;
  console.log = (...values: unknown[]) => output.push(String(values[0]));

  await runLocalCli(["run", "Reply only with: BRIDGE_OK"]);

  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), {
    id: "bridge-cli-0",
    prompt: "Reply only with: BRIDGE_OK",
  });
  assert.equal(requests[1].url, "http://127.0.0.1:8787/api/v1/tasks/task-1");
  assert.equal(requests[2].url, "http://127.0.0.1:8787/api/v1/tasks/task-1/result");
  assert.deepEqual(output, ["BRIDGE_OK"]);
});
