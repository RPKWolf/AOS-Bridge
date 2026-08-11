import * as assert from "node:assert/strict";
import test from "node:test";
import {
  OperationVerification,
  type OperationVerificationEnvironment,
} from "../orchestration/operation-verification";

test("verifies declared commit, PR, files, tests, and git diff check", async () => {
  const commands: Array<{ command: string; args: readonly string[] }> = [];
  const environment: OperationVerificationEnvironment = {
    async fileExists(path) {
      return path === "src/example.ts";
    },
    async run(command, args) {
      commands.push({ command, args });
      return { exitCode: 0, stderr: "" };
    },
    now() {
      return "2026-08-11T00:00:00.000Z";
    },
  };

  const result = await new OperationVerification(environment).verify({
    id: "operation-1",
    taskResult: { id: "task-1", status: "completed" },
    declaredArtifacts: {
      commit: "abc123",
      pullRequest: 42,
      files: ["src/example.ts"],
      testsPassed: true,
      gitDiffCheckPassed: true,
    },
  });

  assert.equal(result.status, "PASS");
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.verifiedArtifacts, [
    "commit:abc123",
    "pull request:42",
    "file:src/example.ts",
    "tests:npm test",
    "git diff --check:git diff --check",
  ]);
  assert.equal(result.timestamp, "2026-08-11T00:00:00.000Z");
  assert.deepEqual(commands, [
    { command: "git", args: ["rev-parse", "--verify", "abc123^{commit}"] },
    { command: "gh", args: ["pr", "view", "42", "--json", "number"] },
    { command: "npm", args: ["test"] },
    { command: "git", args: ["diff", "--check"] },
  ]);
});

test("returns objective verification findings for missing or failed artifacts", async () => {
  const environment: OperationVerificationEnvironment = {
    async fileExists() {
      return false;
    },
    async run(command) {
      return command === "git"
        ? { exitCode: 1, stderr: "not found" }
        : { exitCode: 1, stderr: "tests failed" };
    },
    now() {
      return "2026-08-11T00:00:00.000Z";
    },
  };

  const result = await new OperationVerification(environment).verify({
    id: "operation-1",
    taskResult: { id: "task-1", status: "completed" },
    declaredArtifacts: {
      commit: "missing",
      files: ["src/missing.ts"],
      testsPassed: true,
    },
  });

  assert.equal(result.status, "FAIL");
  assert.deepEqual(result.verifiedArtifacts, []);
  assert.deepEqual(result.findings, [
    "Verification failed for commit missing: not found",
    "Required file is missing: src/missing.ts",
    "Verification failed for tests npm test: tests failed",
  ]);
});
