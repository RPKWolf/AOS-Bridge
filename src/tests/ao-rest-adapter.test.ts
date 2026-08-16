import * as assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { AoRestAdapter } from "../adapters/ao-rest-adapter";
import { AoProtocolError, UnsupportedAgentOrchestratorVersionError } from "../errors/bridge-error";

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
    if (url.endsWith("/api/v1/projects")) {
      return Response.json({ projects: [{ id: "project-1" }] });
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
  assert.equal(JSON.parse(String(requests[3].init?.body)).projectId, "project-1");
  assert.deepEqual(JSON.parse(String(requests[4].init?.body)), {
    text: "Reply only with: BRIDGE_OK",
    clientMessageId: "request-1",
  });
});

test("routes explicit registered projects exactly and audits the choice", async () => {
  const spawnedProjects: string[] = [];
  const auditEntries: unknown[] = [];
  globalThis.fetch = createRoutingFetch(
    ["aos", "aos-bridge", "compass"],
    spawnedProjects,
  );
  const adapter = await AoRestAdapter.create({
    baseUrl: "http://ao.test",
    harness: "codex",
    displayName: "Bridge test",
    auditLogger: (entry) => auditEntries.push(entry),
  });

  for (const projectId of ["aos", "aos-bridge", "compass"]) {
    await adapter.submitTask({
      schemaVersion: 2,
      id: `task-${projectId}`,
      prompt: "unchanged",
      routing: { projectId },
      provider: "test",
      orchestrator: "test",
      createdAt: "2026-08-16T00:00:00.000Z",
    });
  }

  assert.deepEqual(spawnedProjects, ["aos", "aos-bridge", "compass"]);
  assert.equal(auditEntries.length, 3);
  assert.deepEqual(adapter.getRoutingAudit("task-aos"), {
    event: "project-routing-resolved",
    taskId: "task-aos",
    requestedProjectId: "aos",
    resolvedProjectId: "aos",
    resolution: "explicit",
  });
});

test("fails closed for an unknown explicit project before session spawn", async () => {
  const spawnedProjects: string[] = [];
  globalThis.fetch = createRoutingFetch(["aos"], spawnedProjects);
  const adapter = await AoRestAdapter.create(baseOptions());

  await assert.rejects(adapter.submitTask(task("unknown", "missing")), AoProtocolError);
  assert.deepEqual(spawnedProjects, []);
});

test("uses the only registered project when routing is omitted", async () => {
  const spawnedProjects: string[] = [];
  globalThis.fetch = createRoutingFetch(["aos"], spawnedProjects);
  const adapter = await AoRestAdapter.create(baseOptions());

  await adapter.submitTask(task("fallback"));

  assert.deepEqual(spawnedProjects, ["aos"]);
  assert.equal(adapter.getRoutingAudit("fallback")?.resolution, "single-eligible-fallback");
});

test("fails closed without a unique fallback and ignores environment and cwd", async () => {
  const originalProject = process.env.AO_PROJECT_ID;
  const originalCwd = process.cwd();
  process.env.AO_PROJECT_ID = "aos";
  try {
    for (const projects of [[], ["aos", "aos-bridge"]]) {
      const spawnedProjects: string[] = [];
      globalThis.fetch = createRoutingFetch(projects, spawnedProjects);
      const adapter = await AoRestAdapter.create({ ...baseOptions(), projectId: "aos-bridge" });
      await assert.rejects(adapter.submitTask(task(`ambiguous-${projects.length}`)), AoProtocolError);
      assert.deepEqual(spawnedProjects, []);
      assert.equal(process.cwd(), originalCwd);
    }
  } finally {
    if (originalProject === undefined) delete process.env.AO_PROJECT_ID;
    else process.env.AO_PROJECT_ID = originalProject;
  }
});

test("keeps a task project immutable across a failed spawn retry", async () => {
  const spawnedProjects: string[] = [];
  globalThis.fetch = createRoutingFetch(["aos", "aos-bridge"], spawnedProjects, true);
  const adapter = await AoRestAdapter.create(baseOptions());

  await assert.rejects(adapter.submitTask(task("fixed", "aos")), AoProtocolError);
  await assert.rejects(
    adapter.submitTask(task("fixed", "aos-bridge")),
    (error: unknown) => error instanceof AoProtocolError && /already routed/.test(error.message),
  );
  assert.deepEqual(spawnedProjects, ["aos"]);
});

function baseOptions() {
  return { baseUrl: "http://ao.test", harness: "codex", displayName: "Bridge test" };
}

function task(id: string, projectId?: string) {
  return {
    id,
    prompt: "prompt",
    ...(projectId === undefined ? {} : { routing: { projectId } }),
    provider: "test",
    orchestrator: "test",
    createdAt: "2026-08-16T00:00:00.000Z",
  };
}

function createRoutingFetch(
  projects: string[],
  spawnedProjects: string[],
  failSpawn = false,
): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    if (init?.method === "OPTIONS") return new Response(null, { status: 405 });
    if (url.endsWith("/api/v1/projects")) {
      return Response.json({ projects: projects.map((id) => ({ id })) });
    }
    if (url.endsWith("/api/v1/sessions")) {
      spawnedProjects.push(JSON.parse(String(init?.body)).projectId);
      if (failSpawn) return Response.json({ unexpected: true }, { status: 201 });
      return Response.json({ session: { id: `session-${spawnedProjects.length}` } }, { status: 201 });
    }
    return Response.json({ duplicate: false, turnId: `turn-${spawnedProjects.length}` }, { status: 202 });
  };
}

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
