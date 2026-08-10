import { ChiefEngineerClient } from "../client/chief-engineer-client";
import type { TaskResult, TaskStatus } from "../types/task";
import type { BridgeTaskClient } from "./contracts";

export class ChiefEngineerBridgeTaskClient implements BridgeTaskClient {
  public constructor(private readonly client: ChiefEngineerClient = new ChiefEngineerClient()) {}

  public submitTask(prompt: string): Promise<string> {
    return this.client.submitTask(prompt);
  }

  public getStatus(taskId: string): Promise<TaskStatus> {
    return this.client.getStatus(taskId);
  }

  public getResult(taskId: string): Promise<TaskResult> {
    return this.client.getResult(taskId);
  }
}
