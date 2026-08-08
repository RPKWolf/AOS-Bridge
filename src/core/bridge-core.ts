import type { OrchestratorAdapter } from "../adapters/orchestrator-adapter";
import type {
  TaskHandle,
  TaskRequest,
  TaskResult,
  TaskStatus,
} from "../types/task";
import { InMemoryTaskStore, type TaskStore } from "./task-store";

/** Coordinates task operations through an orchestration adapter. */
export class BridgeCore {
  public constructor(
    private readonly orchestratorAdapter: OrchestratorAdapter,
    private readonly taskStore: TaskStore = new InMemoryTaskStore(),
  ) {}

  public async submitTask(request: TaskRequest): Promise<TaskHandle> {
    const handle = await this.orchestratorAdapter.submitTask(request);
    this.taskStore.set({ handle, status: "pending" });

    return handle;
  }

  public async getTaskStatus(handle: TaskHandle): Promise<TaskStatus> {
    const status = await this.orchestratorAdapter.getTaskStatus(handle);
    const storedTask = this.taskStore.get(handle);

    this.taskStore.set({
      handle,
      status,
      ...(storedTask?.result ? { result: storedTask.result } : {}),
    });

    return status;
  }

  public async getTaskResult(handle: TaskHandle): Promise<TaskResult> {
    const status = await this.getTaskStatus(handle);

    if (status !== "completed") {
      throw new Error(`Task ${handle.turnId} is not completed`);
    }

    const storedTask = this.taskStore.get(handle);
    if (storedTask?.result) {
      return storedTask.result;
    }

    const result = await this.orchestratorAdapter.getTaskResult(handle);
    this.taskStore.set({ handle, status, result });

    return result;
  }
}
