import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  AoProtocolError,
  AoRequestError,
  AgentOrchestratorTimeoutError,
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

  if (request.method === "GET" && url.pathname === "/control") {
    writeHtml(response, 200, CONTROL_PAGE);
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

  if (request.method === "POST" && url.pathname === "/api/v1/agent-task") {
    const prompt = parseAgentTask(await readJson(request));
    writeJson(response, 202, await gateway.submitAgentTask(prompt));
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

function parseAgentTask(value: unknown): string {
  if (!isRecord(value) || typeof value.prompt !== "string") {
    throw new InvalidRequestError("Request body must contain a string prompt field");
  }

  return value.prompt;
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

function writeHtml(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  response.end(body);
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

  if (error instanceof AgentOrchestratorTimeoutError) {
    return { status: 504, code: "ORCHESTRATOR_TIMEOUT", message: error.message };
  }

  if (error instanceof BridgeError) {
    return { status: 500, code: "BRIDGE_ERROR", message: error.message };
  }

  return { status: 500, code: "INTERNAL_ERROR", message: "Internal Bridge error" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const CONTROL_PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AOS-Bridge Control</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 48rem; padding: 0 1rem; }
    textarea { box-sizing: border-box; min-height: 9rem; width: 100%; }
    button { margin-top: 0.75rem; padding: 0.5rem 1rem; }
    pre { background: #f3f4f6; overflow-wrap: anywhere; padding: 0.75rem; white-space: pre-wrap; }
    #log { max-height: 12rem; overflow-y: auto; }
  </style>
</head>
<body>
  <h1>AOS-Bridge Control</h1>
  <p>Bridge status: <strong id="bridge-status">Checking…</strong></p>
  <form id="task-form">
    <label for="prompt">Prompt</label>
    <textarea id="prompt" name="prompt" required></textarea>
    <button type="submit">Submit</button>
  </form>
  <p>Current task: <code id="task-id">—</code></p>
  <p>Status: <strong id="task-status">—</strong></p>
  <p>Heartbeat: <strong id="heartbeat">inactive</strong> (<span id="poll-count">0</span> polls)</p>
  <h2>Result</h2>
  <pre id="result">—</pre>
  <h2>Log</h2>
  <pre id="log"></pre>
  <script>
    (function () {
      var bridgeStatus = document.getElementById("bridge-status");
      var form = document.getElementById("task-form");
      var prompt = document.getElementById("prompt");
      var taskId = document.getElementById("task-id");
      var taskStatus = document.getElementById("task-status");
      var heartbeat = document.getElementById("heartbeat");
      var pollCount = document.getElementById("poll-count");
      var result = document.getElementById("result");
      var log = document.getElementById("log");
      var previousStatus = null;
      var polls = 0;

      function writeLog(message) {
        log.textContent += message + "\n";
        log.scrollTop = log.scrollHeight;
      }

      async function readJson(response) {
        var payload = await response.json();
        if (!response.ok) {
          throw new Error(payload && payload.error && payload.error.message ? payload.error.message : "Bridge request failed");
        }
        return payload;
      }

      async function refreshHealth() {
        try {
          var health = await readJson(await fetch("/health"));
          bridgeStatus.textContent = health.status;
        } catch (error) {
          bridgeStatus.textContent = "unavailable";
          writeLog(error.message);
        }
      }

      async function poll(id) {
        var statusPayload = await readJson(await fetch("/api/v1/tasks/" + encodeURIComponent(id)));
        taskStatus.textContent = statusPayload.status;
        polls += 1;
        pollCount.textContent = String(polls);
        heartbeat.textContent = new Date().toLocaleTimeString() + " — active";
        if (statusPayload.status !== previousStatus) {
          writeLog(new Date().toLocaleTimeString() + " transition: " + (previousStatus || "submitted") + " → " + statusPayload.status);
          previousStatus = statusPayload.status;
        }

        if (statusPayload.status === "completed") {
          var resultPayload = await readJson(await fetch("/api/v1/tasks/" + encodeURIComponent(id) + "/result"));
          result.textContent = resultPayload.output;
          heartbeat.textContent = new Date().toLocaleTimeString() + " — terminal";
          writeLog("Task completed");
          return;
        }

        if (statusPayload.status === "failed" || statusPayload.status === "interrupted") {
          heartbeat.textContent = new Date().toLocaleTimeString() + " — terminal";
          throw new Error("Task ended with status " + statusPayload.status);
        }

        window.setTimeout(function () {
          poll(id).catch(function (error) { writeLog(error.message); });
        }, 1000);
      }

      form.addEventListener("submit", async function (event) {
        event.preventDefault();
        var id = "control-" + Date.now();
        previousStatus = null;
        polls = 0;
        pollCount.textContent = "0";
        heartbeat.textContent = "submitting";
        result.textContent = "—";
        taskStatus.textContent = "pending";
        try {
          var submitted = await readJson(await fetch("/api/v1/tasks", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: id, prompt: prompt.value })
          }));
          taskId.textContent = submitted.id;
          writeLog("Submitted task " + submitted.id);
          await poll(submitted.id);
        } catch (error) {
          writeLog(error.message);
        }
      });

      refreshHealth();
    }());
  </script>
</body>
</html>`;
