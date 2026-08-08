const DEFAULT_BRIDGE_URL = "http://127.0.0.1:8787";

export class ChatGptLocalClient {
  private readonly bridgeUrl: string;

  public constructor(bridgeUrl = process.env.BRIDGE_URL ?? DEFAULT_BRIDGE_URL) {
    this.bridgeUrl = bridgeUrl.replace(/\/$/, "");
  }

  public async run(prompt: string): Promise<string> {
    if (typeof prompt !== "string") {
      throw new Error("Prompt must be a string");
    }

    const submitted = await this.request("/api/v1/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: `chatgpt-local-${Date.now()}`, prompt }),
    });
    const taskId = this.getString(submitted, "id", "task submission");

    while (true) {
      const statusPayload = await this.request(`/api/v1/tasks/${encodeURIComponent(taskId)}`);
      const status = this.getString(statusPayload, "status", "task status");

      if (status === "completed") {
        const result = await this.request(
          `/api/v1/tasks/${encodeURIComponent(taskId)}/result`,
        );
        return this.getString(result, "output", "task result");
      }

      if (status === "failed" || status === "interrupted") {
        throw new Error(`Task ${taskId} ended with status ${status}`);
      }

      await delay(1000);
    }
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
