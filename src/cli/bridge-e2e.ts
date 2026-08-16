import { AoRestAdapter } from "../adapters/ao-rest-adapter";
import { BridgeCore } from "../core/bridge-core";
import { InMemoryTaskStore } from "../core/task-store";
import type { TaskRequest } from "../types/task";

declare const process: {
  env: Record<string, string | undefined>;
  exitCode?: number;
};

const terminalStatuses = new Set(["completed", "failed", "interrupted"]);

async function main(): Promise<void> {
  const adapter = await AoRestAdapter.create({
    baseUrl: requiredEnvironment("AO_BASE_URL"),
    harness: requiredEnvironment("AO_HARNESS"),
    displayName: requiredEnvironment("AO_DISPLAY_NAME"),
  });
  const bridge = new BridgeCore(adapter, new InMemoryTaskStore());
  const request: TaskRequest = {
    schemaVersion: 2,
    id: `bridge-e2e-${Date.now()}`,
    prompt: "Reply only with: BRIDGE_OK",
    routing: { projectId: requiredEnvironment("E2E_PROJECT_ID") },
    provider: "manual-e2e",
    orchestrator: "agent-orchestrator",
    createdAt: new Date().toISOString(),
  };
  const handle = await bridge.submitTask(request);

  console.log("TaskHandle:", handle);

  while (true) {
    const status = await bridge.getTaskStatus(handle);
    console.log("TaskStatus:", status);

    if (!terminalStatuses.has(status)) {
      await delay(1000);
      continue;
    }

    if (status !== "completed") {
      throw new Error(`Task ${handle.turnId} ended with status ${status}`);
    }

    const result = await bridge.getTaskResult(handle);
    console.log("TaskResult.output:", result.output);
    return;
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
