import type { OrchestratorAdapter } from "../adapters/orchestrator-adapter";
import { AgentOrchestratorTimeoutError } from "../errors/bridge-error";
import type { TaskRequest } from "../types/task";

const DEFAULT_TIMEOUT_MILLISECONDS = 30_000;

export interface AcceptedAgentTask {
  taskId: string;
  status: "accepted";
}

export interface AgentTaskAdapter {
  submitTask(request: TaskRequest): Promise<AcceptedAgentTask>;
}

export class AgentOrchestratorAdapter implements AgentTaskAdapter {
  public constructor(
    private readonly orchestrator: OrchestratorAdapter,
    private readonly timeoutMilliseconds = DEFAULT_TIMEOUT_MILLISECONDS,
  ) {}

  public async submitTask(request: TaskRequest): Promise<AcceptedAgentTask> {
    await this.withTimeout(this.orchestrator.submitTask(request));

    return { taskId: request.id, status: "accepted" };
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
