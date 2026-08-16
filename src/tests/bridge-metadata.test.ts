import * as assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { loadBridgeMetadata } from "../gateway/bridge-metadata";

test("loads version from package.json and commit from the current checkout", () => {
  const packageJson = require(resolve(__dirname, "../../package.json")) as { version: string };
  const metadata = loadBridgeMetadata();
  assert.equal(metadata.version, packageJson.version);
  assert.match(metadata.commit, /^[0-9a-f]+$/);
});

test("uses unknown commit without git metadata and still loads", () => {
  const directory = mkdtempSync(join(tmpdir(), "aos-bridge-metadata-"));
  const packagePath = join(directory, "package.json");
  try {
    writeFileSync(packagePath, JSON.stringify({ version: "9.8.7" }));
    assert.deepEqual(loadBridgeMetadata(packagePath, directory), {
      version: "9.8.7",
      commit: "unknown",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
