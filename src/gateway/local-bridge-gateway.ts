import { BridgeCore } from "../core/bridge-core";
import {
  InvalidRequestError,
  TaskUnavailableError,
} from "../errors/bridge-error";
import type { TaskHandle, TaskResult, TaskStatus } from "../types/task";

export interface SubmitTaskInput {
  id: string;
  prompt: string;
}

export interface LocalGatewayTaskDefaults {
  provider: string;
  orchestrator: string;
}

export class LocalBridgeGateway {
  private readonly handles = new Map<string, TaskHandle>();

  public constructor(
    private readonly bridge: BridgeCore,
    private readonly taskDefaults: LocalGatewayTaskDefaults,
  ) {}

  public async submitTask(input: SubmitTaskInput): Promise<TaskHandle> {
    this.validateSubmitInput(input);

    if (this.handles.has(input.id)) {
      throw new InvalidRequestError(`Task ${input.id} already exists`);
    }

    const handle = await this.bridge.submitTask({
      id: input.id,
      prompt: input.prompt,
      provider: this.taskDefaults.provider,
      orchestrator: this.taskDefaults.orchestrator,
      createdAt: new Date().toISOString(),
    });
    this.handles.set(input.id, handle);

    return handle;
  }

  public async getTaskStatus(id: string): Promise<TaskStatus> {
    return this.bridge.getTaskStatus(this.getHandle(id));
  }

  public async getTaskResult(id: string): Promise<TaskResult> {
    return this.bridge.getTaskResult(this.getHandle(id));
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
