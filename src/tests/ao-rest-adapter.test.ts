import * as assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { AoRestAdapter } from "../adapters/ao-rest-adapter";
import { UnsupportedAgentOrchestratorVersionError } from "../errors/bridge-error";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("checks compatibility and submits the request prompt unchanged", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });

    if (init?.method === "OPTIONS") {
      return new Response(null, { status: 405 });
    }
    if (url.endsWith("/api/v1/sessions")) {
      return Response.json({ session: { id: "session-1" } }, { status: 201 });
    }

    return Response.json({ duplicate: false, turnId: "turn-1" }, { status: 202 });
  };

  const adapter = await AoRestAdapter.create({
    baseUrl: "http://ao.test",
    projectId: "project-1",
    harness: "codex",
    displayName: "Bridge test",
  });
  const handle = await adapter.submitTask({
    id: "request-1",
    prompt: "Reply only with: BRIDGE_OK",
    provider: "test",
    orchestrator: "test",
    createdAt: "2026-08-08T00:00:00.000Z",
  });

  assert.deepEqual(handle, { sessionId: "session-1", turnId: "turn-1" });
  assert.deepEqual(JSON.parse(String(requests[3].init?.body)), {
    text: "Reply only with: BRIDGE_OK",
    clientMessageId: "request-1",
  });
});

test("rejects an AO version without the public Chat REST API", async () => {
  globalThis.fetch = async () => new Response(null, { status: 404 });

  await assert.rejects(
    AoRestAdapter.create({
      baseUrl: "http://ao.test",
      projectId: "project-1",
      harness: "codex",
      displayName: "Bridge test",
    }),
    (error: unknown) =>
      error instanceof UnsupportedAgentOrchestratorVersionError &&
      error.message ===
        "This Agent Orchestrator version does not expose the required public Chat REST API.",
  );
});
