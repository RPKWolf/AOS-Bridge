import { AoRestAdapter } from "../adapters/ao-rest-adapter";
import { BridgeCore } from "../core/bridge-core";
import { InMemoryTaskStore } from "../core/task-store";
import { InvalidConfigurationError } from "../errors/bridge-error";
import { LocalBridgeGateway } from "../gateway/local-bridge-gateway";
import { AgentOrchestratorAdapter } from "../gateway/agent-orchestrator-adapter";
import { createLocalBridgeServer, listenOnLoopback } from "../gateway/local-bridge-server";

async function main(): Promise<void> {
  const adapter = await AoRestAdapter.create({
    baseUrl: requiredEnvironment("AO_BASE_URL"),
    harness: requiredEnvironment("AO_HARNESS"),
    displayName: requiredEnvironment("AO_DISPLAY_NAME"),
    auditLogger: (entry) => console.info(JSON.stringify(entry)),
  });
  const bridge = new BridgeCore(adapter, new InMemoryTaskStore());
  const gateway = new LocalBridgeGateway(bridge, {
    provider: "local-gateway",
    orchestrator: "agent-orchestrator",
  }, new AgentOrchestratorAdapter(adapter));
  const server = createLocalBridgeServer(gateway);

  await listenOnLoopback(server, bridgePort());
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new InvalidConfigurationError(`Missing required environment variable: ${name}`);
  }

  return value;
}

function bridgePort(): number {
  const host = process.env.BRIDGE_HOST ?? "127.0.0.1";
  if (host !== "127.0.0.1") {
    throw new InvalidConfigurationError("BRIDGE_HOST must be 127.0.0.1");
  }

  const value = process.env.BRIDGE_PORT ?? "8787";
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new InvalidConfigurationError("BRIDGE_PORT must be an integer between 1 and 65535");
  }

  return port;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Bridge server failed");
  process.exitCode = 1;
});
