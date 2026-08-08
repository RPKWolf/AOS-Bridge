import * as assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { ChatGptLocalClient } from "../client/chatgpt-local-client";
import { runChatGptLocalCli } from "../cli/chatgpt-local";

const originalFetch = globalThis.fetch;
const originalLog = console.log;
const originalNow = Date.now;

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  Date.now = originalNow;
});

test("submits, polls, and returns a completed local Bridge result", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  Date.now = () => 0;
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

  const output = await new ChatGptLocalClient().run("Hello");

  assert.equal(output, "BRIDGE_OK");
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), {
    id: "chatgpt-local-0",
    prompt: "Hello",
  });
  assert.equal(requests[1].url, "http://127.0.0.1:8787/api/v1/tasks/task-1");
  assert.equal(requests[2].url, "http://127.0.0.1:8787/api/v1/tasks/task-1/result");
});

test("prints only the final output through the CLI", async () => {
  const output: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);

    if (url.endsWith("/api/v1/tasks")) {
      return Response.json({ id: "task-1", status: "pending" }, { status: 202 });
    }
    if (url.endsWith("/api/v1/tasks/task-1")) {
      return Response.json({ id: "task-1", status: "completed" });
    }

    return Response.json({ id: "task-1", status: "completed", output: "BRIDGE_OK" });
  };
  console.log = (...values: unknown[]) => output.push(String(values[0]));

  await runChatGptLocalCli(["run", "Hello"]);

  assert.deepEqual(output, ["BRIDGE_OK"]);
});
