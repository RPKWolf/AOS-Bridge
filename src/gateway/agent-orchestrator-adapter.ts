import type { OrchestratorAdapter } from "../adapters/orchestrator-adapter";
import {
  AgentOrchestratorTimeoutError,
  AgentTaskFailedError,
  TaskNotCompletedError,
  TaskUnavailableError,
} from "../errors/bridge-error";
import type { TaskHandle, TaskRequest, TaskResult, TaskStatus } from "../types/task";

const DEFAULT_TIMEOUT_MILLISECONDS = 30_000;
const DEFAULT_POLL_INTERVAL_MILLISECONDS = 1_000;

export interface AcceptedAgentTask {
  taskId: string;
  status: "accepted";
}

export interface AgentTaskAdapter {
  submitTask(request: TaskRequest): Promise<AcceptedAgentTask>;
  hasTask(taskId: string): boolean;
  getTaskStatus(taskId: string): Promise<TaskStatus>;
  getTaskResult(taskId: string): Promise<TaskResult>;
}

export class AgentOrchestratorAdapter implements AgentTaskAdapter {
  private readonly handles = new Map<string, TaskHandle>();

  public constructor(
    private readonly orchestrator: OrchestratorAdapter,
    private readonly timeoutMilliseconds = DEFAULT_TIMEOUT_MILLISECONDS,
    private readonly pollIntervalMilliseconds = DEFAULT_POLL_INTERVAL_MILLISECONDS,
  ) {}

  public async submitTask(request: TaskRequest): Promise<AcceptedAgentTask> {
    const handle = await this.withTimeout(this.orchestrator.submitTask(request));
    this.handles.set(request.id, handle);

    return { taskId: request.id, status: "accepted" };
  }

  public getTaskSessionId(taskId: string): string {
    return this.getHandle(taskId).sessionId;
  }

  public hasTask(taskId: string): boolean {
    return this.handles.has(taskId);
  }

  public async getTaskStatus(taskId: string): Promise<TaskStatus> {
    return this.orchestrator.getTaskStatus(this.getHandle(taskId));
  }

  public async getTaskResult(taskId: string): Promise<TaskResult> {
    const status = await this.getTaskStatus(taskId);

    if (status !== "completed") {
      throw new TaskNotCompletedError(`Task ${taskId} is not completed`);
    }

    return this.orchestrator.getTaskResult(this.getHandle(taskId));
  }

  public waitForTaskResult(taskId: string): Promise<TaskResult> {
    let timedOut = false;
    const operation = this.pollForTaskResult(taskId, () => timedOut);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        timedOut = true;
        reject(new AgentOrchestratorTimeoutError("Agent Orchestrator request timed out"));
      }, this.timeoutMilliseconds);

      operation.then(
        (value) => {
          if (!timedOut) {
            clearTimeout(timer);
            resolve(value);
          }
        },
        (error: unknown) => {
          if (!timedOut) {
            clearTimeout(timer);
            reject(error);
          }
        },
      );
    });
  }

  private async pollForTaskResult(
    taskId: string,
    hasTimedOut: () => boolean,
  ): Promise<TaskResult> {
    while (true) {
      if (hasTimedOut()) {
        throw new AgentOrchestratorTimeoutError("Agent Orchestrator request timed out");
      }

      const status = await this.getTaskStatus(taskId);

      if (hasTimedOut()) {
        throw new AgentOrchestratorTimeoutError("Agent Orchestrator request timed out");
      }

      if (status === "completed") {
        return this.orchestrator.getTaskResult(this.getHandle(taskId));
      }

      if (status === "failed") {
        throw new AgentTaskFailedError(`Task ${taskId} failed`);
      }

      await delay(this.pollIntervalMilliseconds);
    }
  }

  private getHandle(taskId: string): TaskHandle {
    const handle = this.handles.get(taskId);

    if (!handle) {
      throw new TaskUnavailableError(`Task ${taskId} was not found`);
    }

    return handle;
  }

  private withTimeout<T>(operation: Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new AgentOrchestratorTimeoutError("Agent Orchestrator request timed out"));
      }, this.timeoutMilliseconds);

      operation.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
