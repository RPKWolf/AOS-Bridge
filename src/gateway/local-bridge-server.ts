import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  AoProtocolError,
  AoRequestError,
  BridgeError,
  InvalidRequestError,
  TaskNotCompletedError,
  TaskResultUnavailableError,
  TaskUnavailableError,
  UnsupportedAgentOrchestratorVersionError,
} from "../errors/bridge-error";
import { LocalBridgeGateway, type SubmitTaskInput } from "./local-bridge-gateway";

export function createLocalBridgeServer(gateway: LocalBridgeGateway): Server {
  return createServer((request, response) => {
    void handleRequest(gateway, request, response).catch((error: unknown) => {
      writeError(response, error);
    });
  });
}

export function listenOnLoopback(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function handleRequest(
  gateway: LocalBridgeGateway,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  if (request.method === "GET" && url.pathname === "/health") {
    writeJson(response, 200, { status: "ok" });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/v1/tasks") {
    const input = parseSubmitTask(await readJson(request));
    const handle = await gateway.submitTask(input);
    writeJson(response, 202, {
      id: input.id,
      sessionId: handle.sessionId,
      turnId: handle.turnId,
      status: "pending",
    });
    return;
  }

  const taskMatch = /^\/api\/v1\/tasks\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && taskMatch) {
    const id = decodeTaskId(taskMatch[1]);
    const status = await gateway.getTaskStatus(id);
    writeJson(response, 200, { id, status });
    return;
  }

  const resultMatch = /^\/api\/v1\/tasks\/([^/]+)\/result$/.exec(url.pathname);
  if (request.method === "GET" && resultMatch) {
    const id = decodeTaskId(resultMatch[1]);
    const result = await gateway.getTaskResult(id);
    writeJson(response, 200, {
      id,
      status: "completed",
      output: result.output,
    });
    return;
  }

  writeError(response, new TaskUnavailableError("Route was not found"));
}

function parseSubmitTask(value: unknown): SubmitTaskInput {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.prompt !== "string") {
    throw new InvalidRequestError("Request body must contain string id and prompt fields");
  }

  return { id: value.id, prompt: value.prompt };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new InvalidRequestError("Request body must be valid JSON");
  }
}

function decodeTaskId(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new InvalidRequestError("Task id is not URL encoded correctly");
  }
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function writeError(response: ServerResponse, error: unknown): void {
  const details = errorDetails(error);
  writeJson(response, details.status, { error: { code: details.code, message: details.message } });
}

function errorDetails(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof InvalidRequestError) {
    return { status: 400, code: "INVALID_REQUEST", message: error.message };
  }

  if (error instanceof TaskUnavailableError) {
    return { status: 404, code: "TASK_UNAVAILABLE", message: error.message };
  }

  if (error instanceof TaskNotCompletedError) {
    return { status: 409, code: "TASK_NOT_COMPLETED", message: error.message };
  }

  if (error instanceof TaskResultUnavailableError) {
    return { status: 404, code: "TASK_RESULT_UNAVAILABLE", message: error.message };
  }

  if (error instanceof UnsupportedAgentOrchestratorVersionError) {
    return { status: 503, code: "ORCHESTRATOR_INCOMPATIBLE", message: error.message };
  }

  if (error instanceof AoRequestError || error instanceof AoProtocolError) {
    return { status: 502, code: "ORCHESTRATOR_ERROR", message: error.message };
  }

  if (error instanceof BridgeError) {
    return { status: 500, code: "BRIDGE_ERROR", message: error.message };
  }

  return { status: 500, code: "INTERNAL_ERROR", message: "Internal Bridge error" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
