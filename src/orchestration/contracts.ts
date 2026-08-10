import type { TaskResult, TaskStatus } from "../types/task";

export type DecisionStatus = "PASS" | "FAIL";

export type OrchestrationStatus =
  | "created"
  | "selecting-agent"
  | "submitted"
  | "waiting-for-work"
  | "validating"
  | "completed"
  | "failed"
  | "interrupted";

export interface AgentCapabilities {
  roles: readonly string[];
  capabilities: readonly string[];
}

export interface AgentProfile {
  id: string;
  capabilities: AgentCapabilities;
}

export interface OrchestrationRequest {
  id: string;
  prompt: string;
  requiredCapabilities: readonly string[];
  maxIterations: number;
}

export interface BridgeTaskClient {
  submitTask(prompt: string): Promise<string>;
  getStatus(taskId: string): Promise<TaskStatus>;
  getResult(taskId: string): Promise<TaskResult>;
}

export interface AgentSelector {
  select(request: OrchestrationRequest): AgentProfile;
}

export interface ValidationDecision {
  status: DecisionStatus;
  findings: readonly string[];
  authorityId: string;
}

export interface ResultValidator {
  validate(
    request: OrchestrationRequest,
    result: TaskResult,
  ): Promise<ValidationDecision>;
}

export interface OrchestrationOutcome {
  id: string;
  taskId: string;
  agentId: string;
  status: OrchestrationStatus;
  result?: TaskResult;
  decision?: ValidationDecision;
}
