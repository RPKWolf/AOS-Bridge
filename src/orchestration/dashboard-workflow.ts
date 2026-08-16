import { randomUUID } from "node:crypto";
import type { TaskResult } from "../types/task";
import type { AcceptedAgentTask } from "../gateway/agent-orchestrator-adapter";
import type { TaskRequest } from "../types/task";

const SHA_PATTERN = /^[0-9a-f]{40}$/;
export const DEFAULT_MAX_REMEDIATIONS = 3;

export type ValidationFailureCode =
  | "UNKNOWN_COMMIT" | "COMMIT_MISMATCH" | "VALIDATION_FAILED"
  | "AMBIGUOUS" | "MULTIPLE_SOLUTIONS" | "MISSING_INPUT" | "PERMISSION_REQUIRED"
  | "SECURITY_RISK" | "SCOPE_EXCEEDED" | "HUMAN_DECISION_REQUIRED"
  | "ROUTING_CONFLICT" | "WORKTREE_CONFLICT";

const FAIL_CLOSED_CODES = new Set<ValidationFailureCode>([
  "UNKNOWN_COMMIT", "COMMIT_MISMATCH", "AMBIGUOUS", "MULTIPLE_SOLUTIONS", "MISSING_INPUT",
  "PERMISSION_REQUIRED", "SECURITY_RISK", "SCOPE_EXCEEDED", "HUMAN_DECISION_REQUIRED",
  "ROUTING_CONFLICT", "WORKTREE_CONFLICT",
]);

export interface DashboardWorkflowTaskClient {
  submitTask(request: TaskRequest): Promise<AcceptedAgentTask>;
  waitForTaskResult(taskId: string): Promise<TaskResult>;
  getTaskSessionId?(taskId: string): string | undefined;
}

export interface DashboardWorkflowRequest {
  id: string;
  projectId: string;
  baseCommit: string;
  prompt: string;
  /** Optional explicit override; autonomous remediation defaults to three attempts. */
  maxRemediations?: number;
}

export type DashboardWorkflowPhase = "implementation" | "validation" | "remediation";

export interface DashboardWorkflowAuditEntry {
  correlationId: string;
  taskId: string;
  phase: DashboardWorkflowPhase;
  projectId: string;
  targetCommit: string;
  status: "submitted" | "PASS" | "FAIL";
  attemptNumber?: number;
  sessionId?: string;
  resultCommit?: string;
  decision?: "REMEDIATE" | "PASS" | "FAIL_CLOSED";
  originalTask?: string;
  detail?: string;
}

export interface DashboardWorkflowOutcome {
  status: "PASS" | "FAIL";
  correlationId: string;
  projectId: string;
  commit?: string;
  reason?: string;
  audit: readonly DashboardWorkflowAuditEntry[];
}

interface PhaseResult {
  phase: DashboardWorkflowPhase;
  status: "PASS" | "FAIL";
  projectId: string;
  baseCommit?: string;
  targetCommit?: string;
  commit?: string;
  failureSignature?: string;
  failureCode?: ValidationFailureCode;
  findings?: string[];
}

/** Split workflow policy. Every phase is an ordinary, always-new Bridge task/AO session. */
export class DashboardWorkflowCoordinator {
  public constructor(
    private readonly client: DashboardWorkflowTaskClient,
    private readonly provider = "dashboard-workflow",
    private readonly orchestrator = "agent-orchestrator",
    private readonly createCorrelationId: () => string = randomUUID,
    private readonly defaultMaxRemediations = DEFAULT_MAX_REMEDIATIONS,
  ) {}

  public async run(request: DashboardWorkflowRequest): Promise<DashboardWorkflowOutcome> {
    const audit: DashboardWorkflowAuditEntry[] = [];
    const correlationId = this.createCorrelationId();
    try {
      this.validateRequest(request);
      const maxRemediations = request.maxRemediations ?? this.defaultMaxRemediations;
      const implementation = await this.execute(
        request,
        correlationId,
        "implementation",
        request.baseCommit,
        this.implementationPrompt(request, correlationId),
        audit,
      );
      this.requirePhase(implementation, "implementation", request.projectId, request.baseCommit);
      if (implementation.status !== "PASS" || !implementation.commit) {
        return this.failed(correlationId, request.projectId, audit, "Implementation did not return PASS with a commit");
      }
      let targetCommit = this.requireSha(implementation.commit, "implementation commit");
      const failures = new Set<string>();

      for (let remediationCount = 0; ; remediationCount += 1) {
        const validation = await this.execute(
          request,
          correlationId,
          "validation",
          targetCommit,
          this.validationPrompt(request.projectId, targetCommit, correlationId),
          audit,
          remediationCount,
        );
        this.requirePhase(validation, "validation", request.projectId, targetCommit);
        if (validation.status === "PASS") {
          this.recordDecision(audit, "validation", "PASS", remediationCount);
          return { status: "PASS", correlationId, projectId: request.projectId, commit: targetCommit, audit };
        }
        if (validation.failureCode && FAIL_CLOSED_CODES.has(validation.failureCode)) {
          this.recordDecision(audit, "validation", "FAIL_CLOSED", remediationCount);
          return this.failed(correlationId, request.projectId, audit, `Validation failed closed: ${validation.failureCode}`);
        }
        if (!validation.failureSignature?.trim()) {
          return this.failed(correlationId, request.projectId, audit, "Validation FAIL omitted failureSignature");
        }
        if (failures.has(validation.failureSignature)) {
          this.recordDecision(audit, "validation", "FAIL_CLOSED", remediationCount);
          return this.failed(correlationId, request.projectId, audit, "Validation repeated the same failure");
        }
        failures.add(validation.failureSignature);
        if (remediationCount >= maxRemediations) {
          this.recordDecision(audit, "validation", "FAIL_CLOSED", remediationCount);
          return this.failed(correlationId, request.projectId, audit, "Remediation limit exhausted");
        }
        this.recordDecision(audit, "validation", "REMEDIATE", remediationCount + 1);

        const remediation = await this.execute(
          request,
          correlationId,
          "remediation",
          targetCommit,
          this.remediationPrompt(request.projectId, targetCommit, correlationId, validation),
          audit,
          remediationCount + 1,
        );
        this.requirePhase(remediation, "remediation", request.projectId, targetCommit);
        if (remediation.status !== "PASS" || !remediation.commit) {
          return this.failed(correlationId, request.projectId, audit, "Remediation did not return PASS with a commit");
        }
        const nextCommit = this.requireSha(remediation.commit, "remediation commit");
        if (nextCommit === targetCommit) {
          return this.failed(correlationId, request.projectId, audit, "Remediation did not create a new commit");
        }
        targetCommit = nextCommit;
      }
    } catch (error) {
      return this.failed(
        correlationId,
        request.projectId,
        audit,
        error instanceof Error ? error.message : "Dashboard workflow failed closed",
      );
    }
  }

  private async execute(
    request: DashboardWorkflowRequest,
    correlationId: string,
    phase: DashboardWorkflowPhase,
    targetCommit: string,
    prompt: string,
    audit: DashboardWorkflowAuditEntry[],
    attemptNumber = 0,
  ): Promise<PhaseResult> {
    const taskId = `${request.id}:${phase}:${audit.filter((entry) => entry.phase === phase && entry.status === "submitted").length}`;
    audit.push({
      correlationId, taskId, phase, projectId: request.projectId, targetCommit, status: "submitted",
      attemptNumber, ...(phase === "implementation" ? { originalTask: request.prompt } : {}),
    });
    const accepted = await this.client.submitTask({
      schemaVersion: 2,
      id: taskId,
      prompt,
      routing: { projectId: request.projectId },
      provider: this.provider,
      orchestrator: this.orchestrator,
      createdAt: new Date().toISOString(),
      metadata: { correlationId, phase, attemptNumber, baseCommit: targetCommit, targetCommit },
    });
    const sessionId = this.client.getTaskSessionId?.(accepted.taskId);
    audit[audit.length - 1].sessionId = sessionId;
    const taskResult = await this.client.waitForTaskResult(taskId);
    if (taskResult.status !== "completed" || typeof taskResult.output !== "string") {
      throw new Error(`${phase} returned an incomplete task result`);
    }
    const result = this.parseResult(taskResult.output);
    audit.push({
      correlationId, taskId, phase, projectId: request.projectId, targetCommit,
      status: result.status, detail: result.failureSignature ?? result.findings?.join("; "),
      attemptNumber, sessionId, resultCommit: result.commit,
    });
    return result;
  }

  private parseResult(output: string): PhaseResult {
    let value: unknown;
    try { value = JSON.parse(output); } catch { throw new Error("Task output is not valid JSON"); }
    if (!isRecord(value) || !isPhase(value.phase) || (value.status !== "PASS" && value.status !== "FAIL") ||
        typeof value.projectId !== "string") {
      throw new Error("Task output does not satisfy the workflow result contract");
    }
    for (const field of ["baseCommit", "targetCommit", "commit", "failureSignature"] as const) {
      if (value[field] !== undefined && typeof value[field] !== "string") {
        throw new Error(`Task output field ${field} must be a string`);
      }
    }
    if (value.failureCode !== undefined && !isValidationFailureCode(value.failureCode)) {
      throw new Error("Task output field failureCode is invalid");
    }
    if (value.findings !== undefined && (!Array.isArray(value.findings) || value.findings.some((item) => typeof item !== "string"))) {
      throw new Error("Task output field findings must be a string array");
    }
    return value as unknown as PhaseResult;
  }

  private requirePhase(result: PhaseResult, phase: DashboardWorkflowPhase, projectId: string, commit: string): void {
    if (result.phase !== phase) throw new Error(`Expected ${phase} result, received ${result.phase}`);
    if (result.projectId !== projectId) throw new Error(`${phase} projectId mismatch`);
    const reportedCommit = phase === "validation" ? result.targetCommit : result.baseCommit;
    if (reportedCommit !== commit) throw new Error(`${phase} commit mismatch`);
    this.requireSha(reportedCommit, `${phase} reported commit`);
  }

  private validateRequest(request: DashboardWorkflowRequest): void {
    if (!request.id.trim() || !request.projectId.trim() || !request.prompt.trim()) throw new Error("Workflow id, projectId, and prompt are required");
    this.requireSha(request.baseCommit, "baseCommit");
    const maxRemediations = request.maxRemediations ?? this.defaultMaxRemediations;
    if (!Number.isInteger(maxRemediations) || maxRemediations < 0) throw new Error("maxRemediations must be a non-negative integer");
  }

  private requireSha(value: string | undefined, label: string): string {
    if (!value || !SHA_PATTERN.test(value)) throw new Error(`${label} must be a full lowercase 40-character commit SHA`);
    return value;
  }

  private implementationPrompt(request: DashboardWorkflowRequest, correlationId: string): string {
    return `Dashboard implementation phase. Correlation: ${correlationId}. Project: ${request.projectId}. Fail closed unless the project contains base commit ${request.baseCommit}; checkout that exact commit before work. Implement, build, test, and create one local commit. Do not push and do not perform browser validation. Work request:\n${request.prompt}\nReturn only JSON: {"phase":"implementation","status":"PASS|FAIL","projectId":"${request.projectId}","baseCommit":"${request.baseCommit}","commit":"<full lowercase SHA>","findings":[]}.`;
  }

  private validationPrompt(projectId: string, targetCommit: string, correlationId: string): string {
    return `Dashboard validation phase in a new session/worktree. Correlation: ${correlationId}. Project: ${projectId}. Fail closed unless commit ${targetCommit} exists in this project; checkout and verify exactly that commit. Perform build, tests, and browser validation. Do not modify or commit files. Classify FAIL as VALIDATION_FAILED only when findings are unambiguous, safely fixable, in scope, and require no human input; otherwise use UNKNOWN_COMMIT, COMMIT_MISMATCH, AMBIGUOUS, MULTIPLE_SOLUTIONS, MISSING_INPUT, PERMISSION_REQUIRED, SECURITY_RISK, SCOPE_EXCEEDED, HUMAN_DECISION_REQUIRED, ROUTING_CONFLICT, or WORKTREE_CONFLICT. Return only JSON: {"phase":"validation","status":"PASS|FAIL","projectId":"${projectId}","targetCommit":"${targetCommit}","failureCode":"<classification>","failureSignature":"<stable signature required on FAIL>","findings":[]}.`;
  }

  private remediationPrompt(projectId: string, targetCommit: string, correlationId: string, validation: PhaseResult): string {
    return `Dashboard remediation phase in a new session/worktree. Correlation: ${correlationId}. Project: ${projectId}. Fail closed unless commit ${targetCommit} exists in this project; checkout exactly that commit. Fix only these validation findings: ${(validation.findings ?? []).join("; ")}. Build and test, create one new local commit, and do not push. Return only JSON: {"phase":"remediation","status":"PASS|FAIL","projectId":"${projectId}","baseCommit":"${targetCommit}","commit":"<full lowercase SHA>","findings":[]}.`;
  }

  private failed(correlationId: string, projectId: string, audit: DashboardWorkflowAuditEntry[], reason: string): DashboardWorkflowOutcome {
    const lastResult = [...audit].reverse().find((entry) => entry.status !== "submitted");
    if (lastResult && !lastResult.decision) lastResult.decision = "FAIL_CLOSED";
    return { status: "FAIL", correlationId, projectId, reason, audit };
  }

  private recordDecision(audit: DashboardWorkflowAuditEntry[], phase: DashboardWorkflowPhase,
    decision: "REMEDIATE" | "PASS" | "FAIL_CLOSED", attemptNumber: number): void {
    const entry = [...audit].reverse().find((item) => item.phase === phase && item.status !== "submitted");
    if (entry) { entry.decision = decision; entry.attemptNumber = attemptNumber; }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPhase(value: unknown): value is DashboardWorkflowPhase {
  return value === "implementation" || value === "validation" || value === "remediation";
}

function isValidationFailureCode(value: unknown): value is ValidationFailureCode {
  return typeof value === "string" && (value === "VALIDATION_FAILED" || FAIL_CLOSED_CODES.has(value as ValidationFailureCode));
}
