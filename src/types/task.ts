/** Extensible identifier of an AI provider. */
export type ProviderType = string;

/** Extensible identifier of an orchestration provider. */
export type OrchestratorType = string;

/** Lifecycle state of a bridge task. */
export type TaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "interrupted";

/** Identifiers assigned to a task by an orchestration backend. */
export interface TaskHandle {
  sessionId: string;
  turnId: string;
}

/** Lifecycle state reported by an orchestration backend. */
export type OrchestratorStatus =
  | "idle"
  | "working"
  | "waiting"
  | "completed"
  | "failed";

/** Error classification returned for an unsuccessful task. */
export type ErrorCode =
  | "INVALID_REQUEST"
  | "BACKEND_UNAVAILABLE"
  | "TASK_FAILED"
  | "TIMEOUT"
  | "UNKNOWN";

/** Runtime details recorded for a task execution. */
export interface RuntimeMetadata {
  sessionId?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

/** Optional caller-selected AO project routing. */
export interface TaskRouting {
  projectId?: string;
}

/** A task submitted to the bridge. The prompt is passed through unchanged. */
export interface TaskRequest {
  schemaVersion?: 2;
  id: string;
  prompt: string;
  routing?: TaskRouting;
  provider: ProviderType;
  orchestrator: OrchestratorType;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

/** A task outcome returned by the bridge. Output is passed through unchanged. */
export interface TaskResult {
  id: string;
  status: TaskStatus;
  output?: string;
  errorCode?: ErrorCode;
  errorMessage?: string;
  runtime?: RuntimeMetadata;
}
