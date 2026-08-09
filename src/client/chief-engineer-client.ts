import type { TaskResult, TaskStatus } from "../types/task";

const DEFAULT_BRIDGE_URL = "http://127.0.0.1:8787";

export class ChiefEngineerClient {
  private readonly bridgeUrl: string;

  public constructor(bridgeUrl = process.env.BRIDGE_URL ?? DEFAULT_BRIDGE_URL) {
    this.bridgeUrl = bridgeUrl.replace(/\/$/, "");
  }

  public async submitTask(prompt: string): Promise<string> {
    if (typeof prompt !== "string") {
      throw new Error("Prompt must be a string");
    }

    const submitted = await this.request("/api/v1/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: `chief-engineer-${Date.now()}`, prompt }),
    });

    return this.getString(submitted, "id", "task submission");
  }

  public async getStatus(taskId: string): Promise<TaskStatus> {
    const payload = await this.request(`/api/v1/tasks/${encodeURIComponent(taskId)}`);
    return this.getStatusValue(payload, "task status");
  }

  public async getResult(taskId: string): Promise<TaskResult> {
    const payload = await this.request(`/api/v1/tasks/${encodeURIComponent(taskId)}/result`);

    if (!isRecord(payload)) {
      throw new Error("Invalid task result response");
    }

    const id = this.getString(payload, "id", "task result");
    const status = this.getStatusValue(payload, "task result");
    const output = this.getString(payload, "output", "task result");

    return { id, status, output };
  }

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    let response: Response;

    try {
      response = await fetch(`${this.bridgeUrl}${path}`, init);
    } catch {
      throw new Error("Local Bridge request failed");
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("Local Bridge returned an invalid JSON response");
    }

    if (!response.ok) {
      throw new Error(this.getErrorMessage(payload));
    }

    return payload;
  }

  private getStatusValue(value: unknown, context: string): TaskStatus {
    const status = this.getString(value, "status", context);

    if (
      status !== "pending" &&
      status !== "running" &&
      status !== "completed" &&
      status !== "failed" &&
      status !== "interrupted"
    ) {
      throw new Error(`Invalid ${context} response`);
    }

    return status;
  }

  private getString(value: unknown, key: string, context: string): string {
    if (!isRecord(value) || typeof value[key] !== "string") {
      throw new Error(`Invalid ${context} response`);
    }

    return value[key];
  }

  private getErrorMessage(value: unknown): string {
    if (
      isRecord(value) &&
      isRecord(value.error) &&
      typeof value.error.message === "string"
    ) {
      return value.error.message;
    }

    return "Local Bridge request failed";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
