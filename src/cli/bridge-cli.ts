import { InvalidConfigurationError } from "../errors/bridge-error";

export async function runLocalCli(args: string[]): Promise<void> {
  if (args.length !== 2 || args[0] !== "run") {
    throw new InvalidConfigurationError('Usage: npm run bridge:cli -- run "PROMPT"');
  }

  const response = await fetch(`${bridgeBaseUrl()}/api/v1/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: `bridge-cli-${Date.now()}`, prompt: args[1] }),
  });
  const submitted = await readResponse(response);
  const task = submitted as { id?: unknown };

  if (!response.ok || typeof task.id !== "string") {
    throw new InvalidConfigurationError(responseMessage(submitted));
  }

  while (true) {
    const statusResponse = await fetch(`${bridgeBaseUrl()}/api/v1/tasks/${encodeURIComponent(task.id)}`);
    const statusPayload = await readResponse(statusResponse);
    const status = isRecord(statusPayload) ? statusPayload.status : undefined;

    if (!statusResponse.ok || typeof status !== "string") {
      throw new InvalidConfigurationError(responseMessage(statusPayload));
    }

    if (status === "completed") {
      const resultResponse = await fetch(
        `${bridgeBaseUrl()}/api/v1/tasks/${encodeURIComponent(task.id)}/result`,
      );
      const resultPayload = await readResponse(resultResponse);
      const output = isRecord(resultPayload) ? resultPayload.output : undefined;

      if (!resultResponse.ok || typeof output !== "string") {
        throw new InvalidConfigurationError(responseMessage(resultPayload));
      }

      console.log(output);
      return;
    }

    if (status === "failed" || status === "interrupted") {
      throw new InvalidConfigurationError(`Task ${task.id} ended with status ${status}`);
    }

    await delay(1000);
  }
}

function bridgeBaseUrl(): string {
  const host = process.env.BRIDGE_HOST ?? "127.0.0.1";
  if (host !== "127.0.0.1") {
    throw new InvalidConfigurationError("BRIDGE_HOST must be 127.0.0.1");
  }

  const port = process.env.BRIDGE_PORT ?? "8787";
  return `http://${host}:${port}`;
}

async function readResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new InvalidConfigurationError("Bridge returned an invalid JSON response");
  }
}

function responseMessage(payload: unknown): string {
  if (isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === "string") {
    return payload.error.message;
  }

  return "Bridge request failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

if (require.main === module) {
  runLocalCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Bridge CLI failed");
    process.exitCode = 1;
  });
}
