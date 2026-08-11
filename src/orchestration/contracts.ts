import type { TaskResult, TaskStatus } from "../types/task";

export type DecisionStatus = "PASS" | "FAIL";

export type OrchestrationMode = "validated" | "pilot";

export type OrchestrationStatus =
  | "created"
  | "selecting-agent"
  | "submitted"
  | "waiting-for-work"
  | "validating"
  | "completed"
  | "pilot-completed"
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

export interface ValidatedResult {
  result: TaskResult;
  validation: ValidationDecision;
}

export interface PilotResult {
  mode: "pilot";
  status: "PILOT";
  findings: readonly string[];
}

export type OrchestrationExecutionResult = TaskResult | DecisionResult | PilotResult;

export interface ResultValidator {
  validate(
    request: OrchestrationRequest,
    result: TaskResult,
  ): Promise<ValidationDecision>;
}

export interface DecisionAuthority {
  decide(
    request: OrchestrationRequest,
    validatedResult: ValidatedResult,
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
  mode: OrchestrationMode;
  status: OrchestrationStatus;
  result?: TaskResult;
  validation?: ValidationDecision;
  decision?: DecisionResult;
}
