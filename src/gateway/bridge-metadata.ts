import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

export interface BridgeMetadata {
  version: string;
  commit: string;
}

export function loadBridgeMetadata(
  packagePath = resolve(__dirname, "../../package.json"),
  checkoutPath = resolve(__dirname, "../.."),
): BridgeMetadata {
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: unknown };
  if (typeof packageJson.version !== "string" || !packageJson.version.trim()) {
    throw new Error("package.json must contain a non-empty version");
  }

  return {
    version: packageJson.version,
    commit: readGitCommit(checkoutPath),
  };
}

function readGitCommit(checkoutPath: string): string {
  try {
    const result = spawnSync("git", ["-C", checkoutPath, "rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    });
    const commit = result.status === 0 ? result.stdout.trim() : "";
    return /^[0-9a-f]+$/i.test(commit) ? commit : "unknown";
  } catch {
    return "unknown";
  }
}
