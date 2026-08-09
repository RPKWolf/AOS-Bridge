import type { TaskRequest } from "../types/task";

export interface AcceptedAgentTask {
  status: "accepted";
}

export class AgentOrchestratorStub {
  public accept(task: TaskRequest): AcceptedAgentTask {
    void task;
    console.log("Agent Orchestrator Stub");
    return { status: "accepted" };
  }
}
