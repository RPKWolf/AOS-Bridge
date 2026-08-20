import { BridgeCore } from "../core/bridge-core";
import {
  InvalidRequestError,
  TaskUnavailableError,
} from "../errors/bridge-error";
import type { TaskHandle, TaskResult, TaskStatus } from "../types/task";
import type { AgentTaskAdapter } from "./agent-orchestrator-adapter";
import { applyWorkExecutionPolicy } from "../orchestration/work-execution-policy";

export interface SubmitTaskInput {
  schemaVersion?: 2;
  id: string;
  prompt: string;
  routing?: { projectId?: string };
}

export interface LocalGatewayTaskDefaults {
  provider: string;
  orchestrator: string;
}

export interface AcceptedAgentTaskResponse {
  taskId: string;
  status: "accepted";
}

export class LocalBridgeGateway {
  private readonly handles = new Map<string, TaskHandle>();
  private activeProjectId: string | undefined;

  public constructor(
    private readonly bridge: BridgeCore,
    private readonly taskDefaults: LocalGatewayTaskDefaults,
    private readonly agentOrchestrator: AgentTaskAdapter,
  ) {}

  public async submitTask(input: SubmitTaskInput): Promise<TaskHandle> {
    this.validateSubmitInput(input);

    if (this.handles.has(input.id)) {
      throw new InvalidRequestError(`Task ${input.id} already exists`);
    }

    const handle = await this.bridge.submitTask({
      ...(input.schemaVersion === undefined ? {} : { schemaVersion: input.schemaVersion }),
      id: input.id,
      prompt: applyWorkExecutionPolicy(input.prompt),
      ...(input.routing === undefined ? {} : { routing: input.routing }),
      provider: this.taskDefaults.provider,
      orchestrator: this.taskDefaults.orchestrator,
      createdAt: new Date().toISOString(),
    });
    this.handles.set(input.id, handle);
    const resolvedProjectId = this.bridge.getResolvedProjectId(input.id);
    if (resolvedProjectId !== undefined) {
      this.activeProjectId = resolvedProjectId;
    }

    return handle;
  }

  public getActiveProjectId(): string | undefined {
    return this.activeProjectId;
  }

  public async getTaskStatus(id: string): Promise<TaskStatus> {
    if (this.agentOrchestrator.hasTask(id)) {
      return this.agentOrchestrator.getTaskStatus(id);
    }

    return this.bridge.getTaskStatus(this.getHandle(id));
  }

  public async getTaskResult(id: string): Promise<TaskResult> {
    if (this.agentOrchestrator.hasTask(id)) {
      return this.agentOrchestrator.getTaskResult(id);
    }

    return this.bridge.getTaskResult(this.getHandle(id));
  }

  public async submitAgentTask(prompt: string): Promise<AcceptedAgentTaskResponse> {
    if (typeof prompt !== "string") {
      throw new InvalidRequestError("Task prompt must be a string");
    }

    const taskId = `agent-task-${Date.now()}`;
    const accepted = await this.agentOrchestrator.submitTask({
      id: taskId,
      prompt: applyWorkExecutionPolicy(prompt),
      provider: this.taskDefaults.provider,
      orchestrator: this.taskDefaults.orchestrator,
      createdAt: new Date().toISOString(),
    });

    return { taskId, status: accepted.status };
  }

  private getHandle(id: string): TaskHandle {
    const handle = this.handles.get(id);

    if (!handle) {
      throw new TaskUnavailableError(`Task ${id} was not found`);
    }

    return handle;
  }

  private validateSubmitInput(input: SubmitTaskInput): void {
    if (!input.id.trim()) {
      throw new InvalidRequestError("Task id must be a non-empty string");
    }

    if (typeof input.prompt !== "string") {
      throw new InvalidRequestError("Task prompt must be a string");
    }
  }
}
