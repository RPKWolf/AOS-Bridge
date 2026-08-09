import { ChiefEngineerClient } from "../client/chief-engineer-client";

export async function runChiefEngineerCli(args: string[]): Promise<void> {
  if (args.length !== 2 || args[0] !== "run") {
    throw new Error('Usage: npm run chief-engineer:local -- run "PROMPT"');
  }

  const client = new ChiefEngineerClient();
  const taskId = await client.submitTask(args[1]);

  while (true) {
    const status = await client.getStatus(taskId);

    if (status === "completed") {
      const result = await client.getResult(taskId);
      console.log(result.output);
      return;
    }

    if (status === "failed" || status === "interrupted") {
      throw new Error(`Task ${taskId} ended with status ${status}`);
    }

    await delay(1000);
  }
}

if (require.main === module) {
  runChiefEngineerCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Chief Engineer Client failed");
    process.exitCode = 1;
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
