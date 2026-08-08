import * as assert from "node:assert/strict";
import test from "node:test";
import { InMemoryTaskStore } from "../core/task-store";

test("stores tasks independently by session and turn", () => {
  const store = new InMemoryTaskStore();
  const first = { sessionId: "session-a", turnId: "turn-1" };
  const second = { sessionId: "session-b", turnId: "turn-1" };

  store.set({ handle: first, status: "pending" });
  store.set({ handle: second, status: "completed" });

  assert.equal(store.get(first)?.status, "pending");
  assert.equal(store.get(second)?.status, "completed");
});
