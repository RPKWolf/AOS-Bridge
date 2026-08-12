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
  | "awaiting-decision"
  | "blocked"
  | "continuation-limit-reached"
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
  /** Maximum number of new phases the Chief Engineer may start after technical completion. */
  maxContinuations?: number;
  operationArtifacts?: OperationArtifacts;
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

export type OrchestrationExecutionResult =
  | TaskResult
  | DecisionResult
  | VerificationResult
  | PilotResult
  | ChiefEngineerStopResult;

export type ChiefEngineerAction =
  | "CONTINUE"
  | "COMPLETE"
  | "USER_DECISION_REQUIRED"
  | "BLOCKED"
  | "LIMIT_REACHED";

export interface ChiefEngineerTechnicalReview {
  proven: readonly string[];
  rootCause: readonly string[];
  fixed: readonly string[];
  tests: readonly string[];
  unresolved: readonly string[];
  newProblems: readonly string[];
}

export interface ChiefEngineerDecision {
  action: Exclude<ChiefEngineerAction, "LIMIT_REACHED">;
  review: ChiefEngineerTechnicalReview;
  nextStep: string;
  reason: string;
  nextPrompt?: string;
  question?: string;
  recommendedOption?: string;
}

export interface ChiefEngineerReviewContext {
  request: OrchestrationRequest;
  result: OrchestrationExecutionResult;
  taskResult: TaskResult;
  validation?: ValidationDecision;
  decision?: DecisionResult;
  verification?: VerificationResult;
  correctiveIterations: number;
  continuationIteration: number;
}

export interface ChiefEngineerContinuationPolicy {
  review(context: ChiefEngineerReviewContext): Promise<ChiefEngineerDecision>;
}

export type ChiefEngineerAuditRecord = Omit<ChiefEngineerDecision, "action"> & {
  action: ChiefEngineerAction;
  taskId: string;
  correctiveIterations: number;
  continuationIteration: number;
  timestamp: string;
};

export interface ChiefEngineerStopResult {
  status: Exclude<ChiefEngineerAction, "CONTINUE" | "COMPLETE">;
  reason: string;
  nextStep: string;
  question?: string;
  recommendedOption?: string;
}

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

export interface OperationArtifacts {
  commit?: string;
  pullRequest?: number;
  files?: readonly string[];
  testsPassed?: boolean;
  gitDiffCheckPassed?: boolean;
}

export interface OperationResult {
  id: string;
  taskResult: TaskResult;
  declaredArtifacts: OperationArtifacts;
}

export interface VerificationResult {
  status: DecisionStatus;
  findings: readonly string[];
  evidence: readonly string[];
  verifiedArtifacts: readonly string[];
  timestamp: string;
}

export interface OperationVerifier {
  verify(operation: OperationResult): Promise<VerificationResult>;
}

export interface WorkItem {
  id: string;
  taskId: string;
  iteration: number;
  prompt: string;
  findings: readonly string[];
  kind?: "corrective" | "continuation";
  continuationIteration?: number;
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
  verification?: VerificationResult;
}
