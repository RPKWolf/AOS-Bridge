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

export interface DecisionResult {
  status: DecisionStatus;
  findings: readonly string[];
  authorityId: string;
}

export type ValidationDecision = DecisionResult;

export interface ResultValidator {
  validate(
    request: OrchestrationRequest,
    result: TaskResult,
  ): Promise<ValidationDecision>;
}

export interface DecisionAuthority {
  decide(
    request: OrchestrationRequest,
    result: TaskResult,
  ): Promise<DecisionResult>;
}

export interface WorkItem {
  id: string;
  taskId: string;
  iteration: number;
  prompt: string;
  findings: readonly string[];
}

export interface OrchestrationOutcome {
  id: string;
  taskId: string;
  agentId: string;
  status: OrchestrationStatus;
  result?: TaskResult;
  decision?: DecisionResult;
}
