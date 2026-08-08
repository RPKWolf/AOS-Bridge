import { ChatGptLocalClient } from "../client/chatgpt-local-client";

export async function runChatGptLocalCli(args: string[]): Promise<void> {
  if (args.length !== 2 || args[0] !== "run") {
    throw new Error('Usage: npm run chatgpt:local -- run "PROMPT"');
  }

  const output = await new ChatGptLocalClient().run(args[1]);
  console.log(output);
}

if (require.main === module) {
  runChatGptLocalCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "ChatGPT Local Client failed");
    process.exitCode = 1;
  });
}
