import type { TaskHandle, TaskResult, TaskStatus } from "../types/task";

export interface StoredTask {
  handle: TaskHandle;
  status: TaskStatus;
  result?: TaskResult;
}

export interface TaskStore {
  get(handle: TaskHandle): StoredTask | undefined;
  set(task: StoredTask): void;
}

export class InMemoryTaskStore implements TaskStore {
  private readonly tasksBySession = new Map<string, Map<string, StoredTask>>();

  public get(handle: TaskHandle): StoredTask | undefined {
    return this.tasksBySession.get(handle.sessionId)?.get(handle.turnId);
  }

  public set(task: StoredTask): void {
    let tasksByTurn = this.tasksBySession.get(task.handle.sessionId);

    if (!tasksByTurn) {
      tasksByTurn = new Map<string, StoredTask>();
      this.tasksBySession.set(task.handle.sessionId, tasksByTurn);
    }

    tasksByTurn.set(task.handle.turnId, task);
  }
}
