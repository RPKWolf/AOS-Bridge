import type {
  TaskHandle,
  TaskRequest,
  TaskResult,
  TaskStatus,
} from "../types/task";

/** Contract for integrating an orchestration provider. */
export interface OrchestratorAdapter {
  submitTask(request: TaskRequest): Promise<TaskHandle>;
  getTaskStatus(handle: TaskHandle): Promise<TaskStatus>;
  getTaskResult(handle: TaskHandle): Promise<TaskResult>;
}
