import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";
import type {
  OperationResult,
  OperationVerifier,
  VerificationResult,
} from "./contracts";

const execFileAsync = promisify(execFile);

export interface CommandResult {
  exitCode: number;
  stderr: string;
}

export interface OperationVerificationEnvironment {
  fileExists(path: string): Promise<boolean>;
  run(command: string, args: readonly string[]): Promise<CommandResult>;
  now(): string;
}

export class OperationVerification implements OperationVerifier {
  public constructor(private readonly environment: OperationVerificationEnvironment) {}

  public async verify(operation: OperationResult): Promise<VerificationResult> {
    const evidence: string[] = [];
    const verifiedArtifacts: string[] = [];
    const findings: string[] = [];
    const artifacts = operation.declaredArtifacts;

    if (artifacts.commit) {
      await this.verifyCommand(
        "commit",
        artifacts.commit,
        "git",
        ["rev-parse", "--verify", `${artifacts.commit}^{commit}`],
        evidence,
        verifiedArtifacts,
        findings,
      );
    }

    if (artifacts.pullRequest !== undefined) {
      await this.verifyCommand(
        "pull request",
        String(artifacts.pullRequest),
        "gh",
        ["pr", "view", String(artifacts.pullRequest), "--json", "number"],
        evidence,
        verifiedArtifacts,
        findings,
      );
    }

    for (const file of artifacts.files ?? []) {
      if (await this.environment.fileExists(file)) {
        evidence.push(`Required file exists: ${file}`);
        verifiedArtifacts.push(`file:${file}`);
      } else {
        findings.push(`Required file is missing: ${file}`);
      }
    }

    if (artifacts.testsPassed) {
      await this.verifyCommand(
        "tests",
        "npm test",
        "npm",
        ["test"],
        evidence,
        verifiedArtifacts,
        findings,
      );
    }

    if (artifacts.gitDiffCheckPassed) {
      await this.verifyCommand(
        "git diff --check",
        "git diff --check",
        "git",
        ["diff", "--check"],
        evidence,
        verifiedArtifacts,
        findings,
      );
    }

    return {
      status: findings.length === 0 ? "PASS" : "FAIL",
      findings,
      evidence,
      verifiedArtifacts,
      timestamp: this.environment.now(),
    };
  }

  private async verifyCommand(
    label: string,
    artifact: string,
    command: string,
    args: readonly string[],
    evidence: string[],
    verifiedArtifacts: string[],
    findings: string[],
  ): Promise<void> {
    try {
      const result = await this.environment.run(command, args);

      if (result.exitCode === 0) {
        evidence.push(`Verified ${label}: ${artifact}`);
        verifiedArtifacts.push(`${label}:${artifact}`);
      } else {
        findings.push(this.commandFailure(label, artifact, result.stderr));
      }
    } catch (error: unknown) {
      findings.push(
        this.commandFailure(label, artifact, error instanceof Error ? error.message : "unknown error"),
      );
    }
  }

  private commandFailure(label: string, artifact: string, detail: string): string {
    return `Verification failed for ${label} ${artifact}: ${detail || "command failed"}`;
  }
}

export class NodeOperationVerificationEnvironment implements OperationVerificationEnvironment {
  public async fileExists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  public async run(command: string, args: readonly string[]): Promise<CommandResult> {
    try {
      const result = await execFileAsync(command, [...args]);
      return { exitCode: 0, stderr: result.stderr };
    } catch (error: unknown) {
      const failure = error as { code?: number; stderr?: string };
      return { exitCode: failure.code ?? 1, stderr: failure.stderr ?? "command failed" };
    }
  }

  public now(): string {
    return new Date().toISOString();
  }
}
