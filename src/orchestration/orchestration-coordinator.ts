import { TaskNotCompletedError } from "../errors/bridge-error";
import type { TaskResult, TaskStatus } from "../types/task";
import type {
  AgentSelector,
  BridgeTaskClient,
  ChiefEngineerAuditRecord,
  ChiefEngineerContinuationPolicy,
  ChiefEngineerDecision,
  ChiefEngineerStopResult,
  DecisionAuthority,
  DecisionResult,
  OrchestrationExecutionResult,
  OperationVerifier,
  OrchestrationOutcome,
  OrchestrationRequest,
  OrchestrationStatus,
  PilotResult,
  ResultValidator,
  ValidatedResult,
  ValidationDecision,
  VerificationResult,
  WorkItem,
} from "./contracts";
import { applyWorkExecutionPolicy } from "./work-execution-policy";
import { formatContinuationPrompt, validateChiefEngineerDecision } from "./chief-engineer-continuation";

const PILOT_MODE_FINDING =
  "Pilot Mode: validation is disabled, so the worker output is not a final orchestration result.";

export class OrchestrationCoordinator {
  private readonly outcomes = new Map<string, OrchestrationOutcome>();
  private readonly requests = new Map<string, OrchestrationRequest>();
  private readonly workItems = new Map<string, WorkItem[]>();
  private readonly chiefEngineerHistory = new Map<string, ChiefEngineerAuditRecord[]>();

  public constructor(
    private readonly selector: AgentSelector,
    private readonly bridgeTaskClient: BridgeTaskClient,
    private readonly resultValidator?: ResultValidator,
    private readonly pollIntervalMilliseconds = 1_000,
    private readonly decisionAuthority?: DecisionAuthority,
    private readonly operationVerifier?: OperationVerifier,
    private readonly continuationPolicy?: ChiefEngineerContinuationPolicy,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  public async start(request: OrchestrationRequest): Promise<OrchestrationOutcome> {
    if (request.maxContinuations !== undefined &&
      (!Number.isInteger(request.maxContinuations) || request.maxContinuations < 0)) {
      throw new Error("maxContinuations must be a non-negative integer");
    }
    const agent = this.selector.select(request);
    const taskId = await this.bridgeTaskClient.submitTask(applyWorkExecutionPolicy(request.prompt));
    const outcome: OrchestrationOutcome = {
      id: request.id,
      taskId,
      agentId: agent.id,
      mode: this.resultValidator ? "validated" : "pilot",
      status: "submitted",
    };

    this.outcomes.set(request.id, outcome);
    this.requests.set(request.id, request);
    this.workItems.set(request.id, [
      {
        id: `${request.id}:0`,
        taskId,
        iteration: 0,
        prompt: request.prompt,
        findings: [],
      },
    ]);
    this.chiefEngineerHistory.set(request.id, []);
    return outcome;
  }

  public async execute(request: OrchestrationRequest): Promise<OrchestrationExecutionResult> {
    const outcome = await this.start(request);
    let correctiveIteration = 0;
    let continuationIteration = 0;
    let activePrompt = request.prompt;
    for (;;) {
      const result = await this.waitForCompletion(outcome);
      const decision = await this.applyDecision(outcome, result);

      if (isFailResult(decision) && correctiveIteration < request.maxIterations &&
        (outcome.validation || outcome.decision || outcome.verification)) {
        correctiveIteration += 1;
        await this.startFollowUpIteration(
          outcome,
          { ...request, prompt: activePrompt },
          decision.findings,
          correctiveIteration,
        );
        continue;
      }

      if (!this.continuationPolicy || isPilotResult(decision)) {
        return decision;
      }

      let chiefDecision: ChiefEngineerDecision;
      try {
        const policyDecision: unknown = await this.continuationPolicy.review({
          request: this.getRequest(outcome.id),
          result: decision,
          taskResult: result,
          validation: outcome.validation,
          decision: outcome.decision,
          verification: outcome.verification,
          correctiveIterations: correctiveIteration,
          continuationIteration,
        });
        validateChiefEngineerDecision(policyDecision);
        chiefDecision = policyDecision;
      } catch (error: unknown) {
        return this.recordPolicyFailure(outcome, correctiveIteration, continuationIteration, error);
      }

      if ((chiefDecision.action === "CONTINUE" || chiefDecision.action === "COMPLETE") &&
        isFailResult(decision)) {
        return this.recordStop(outcome, chiefDecision, "BLOCKED", correctiveIteration,
          continuationIteration, "Technical result is still FAIL; Chief Engineer policy cannot bypass it.");
      }

      if (chiefDecision.action !== "CONTINUE") {
        this.recordDecision(outcome, chiefDecision, chiefDecision.action, correctiveIteration, continuationIteration);
        if (chiefDecision.action === "USER_DECISION_REQUIRED") outcome.status = "awaiting-decision";
        if (chiefDecision.action === "BLOCKED") outcome.status = "blocked";
        return chiefDecision.action === "COMPLETE" ? decision : toStopResult(chiefDecision);
      }

      const maxContinuations = request.maxContinuations ?? 0;
      if (continuationIteration >= maxContinuations) {
        return this.recordStop(outcome, chiefDecision, "LIMIT_REACHED", correctiveIteration,
          continuationIteration, `Continuation limit ${maxContinuations} reached.`);
      }

      this.recordDecision(outcome, chiefDecision, "CONTINUE", correctiveIteration, continuationIteration);
      continuationIteration += 1;
      correctiveIteration = 0;
      await this.startContinuation(outcome, request, chiefDecision, continuationIteration);
      activePrompt = chiefDecision.nextPrompt!;
    }
  }

  public async getStatus(id: string): Promise<OrchestrationStatus> {
    const outcome = this.getOutcome(id);

    if (isTerminal(outcome.status)) {
      return outcome.status;
    }

    const taskStatus = await this.bridgeTaskClient.getStatus(outcome.taskId);
    outcome.status = this.resolveStatus(taskStatus);
    return outcome.status;
  }

  public getOutcome(id: string): OrchestrationOutcome {
    const outcome = this.outcomes.get(id);

    if (!outcome) {
      throw new Error(`Orchestration ${id} was not found`);
    }

    return outcome;
  }

  public getWorkItems(id: string): readonly WorkItem[] {
    const workItems = this.workItems.get(id);

    if (!workItems) {
      throw new Error(`Orchestration ${id} was not found`);
    }

    return workItems;
  }

  public getChiefEngineerHistory(id: string): readonly ChiefEngineerAuditRecord[] {
    const history = this.chiefEngineerHistory.get(id);
    if (!history) throw new Error(`Orchestration ${id} was not found`);
    return history.map((record) => ({
      ...record,
      review: {
        proven: [...record.review.proven],
        rootCause: [...record.review.rootCause],
        fixed: [...record.review.fixed],
        tests: [...record.review.tests],
        unresolved: [...record.review.unresolved],
        newProblems: [...record.review.newProblems],
      },
      continuationAttestations: record.continuationAttestations ? {
        safety: { ...record.continuationAttestations.safety },
        scope: { ...record.continuationAttestations.scope },
        risk: { ...record.continuationAttestations.risk },
      } : undefined,
    }));
  }

  private async waitForCompletion(outcome: OrchestrationOutcome): Promise<TaskResult> {
    while (true) {
      const status = await this.getStatus(outcome.id);

      if (status === "completed") {
        const result = await this.bridgeTaskClient.getResult(outcome.taskId);
        outcome.result = result;
        return result;
      }

      if (status === "failed" || status === "interrupted") {
        throw new TaskNotCompletedError(
          `Orchestration ${outcome.id} ended with status ${status}`,
        );
      }

      await delay(this.pollIntervalMilliseconds);
    }
  }

  private async applyDecision(
    outcome: OrchestrationOutcome,
    result: TaskResult,
  ): Promise<OrchestrationExecutionResult> {
    if (!this.resultValidator) {
      outcome.status = "pilot-completed";
      return this.createPilotResult();
    }

    outcome.status = "validating";
    const validation = await this.resultValidator.validate(this.getRequest(outcome.id), result);
    outcome.validation = validation;

    if (validation.status === "FAIL") {
      outcome.status = "failed";
      return validation;
    }

    const validatedResult: ValidatedResult = { result, validation };

    if (!this.decisionAuthority) {
      return this.verifyOperation(outcome, result, validation);
    }

    const decision = await this.decisionAuthority.decide(
      this.getRequest(outcome.id),
      validatedResult,
    );
    outcome.decision = decision;

    if (decision.status === "FAIL") {
      outcome.status = "failed";
      return decision;
    }

    return this.verifyOperation(outcome, result, validation);
  }

  private async verifyOperation(
    outcome: OrchestrationOutcome,
    result: TaskResult,
    validation: ValidationDecision,
  ): Promise<OrchestrationExecutionResult> {
    if (!this.operationVerifier) {
      outcome.status = "completed";
      return result;
    }

    const verification = await this.operationVerifier.verify({
      id: outcome.id,
      taskResult: result,
      declaredArtifacts: this.getRequest(outcome.id).operationArtifacts ?? {},
    });
    const verificationWithFindings = {
      ...verification,
      findings: mergeFindings(validation, verification.findings),
    };

    outcome.verification = verificationWithFindings;

    if (verificationWithFindings.status === "FAIL") {
      outcome.status = "failed";
      return verificationWithFindings;
    }

    outcome.status = "completed";
    return result;
  }

  private async startFollowUpIteration(
    outcome: OrchestrationOutcome,
    request: OrchestrationRequest,
    findings: readonly string[],
    iteration: number,
  ): Promise<void> {
    const taskId = await this.bridgeTaskClient.submitTask(
      applyWorkExecutionPolicy(formatFollowUpPrompt(request.prompt, findings)),
    );
    const workItems = this.workItems.get(outcome.id);

    if (!workItems) {
      throw new Error(`Orchestration ${outcome.id} was not found`);
    }

    workItems.push({
      id: `${outcome.id}:${workItems.length}`,
      taskId,
      iteration,
      prompt: request.prompt,
      findings,
    });
    outcome.taskId = taskId;
    outcome.status = "submitted";
    outcome.result = undefined;
    outcome.validation = undefined;
    outcome.decision = undefined;
    outcome.verification = undefined;
  }

  private async startContinuation(
    outcome: OrchestrationOutcome,
    request: OrchestrationRequest,
    decision: ChiefEngineerDecision,
    continuationIteration: number,
  ): Promise<void> {
    const taskId = await this.bridgeTaskClient.submitTask(
      applyWorkExecutionPolicy(formatContinuationPrompt(decision)),
    );
    const workItems = this.workItems.get(outcome.id);
    if (!workItems) throw new Error(`Orchestration ${outcome.id} was not found`);
    workItems.push({
      id: `${outcome.id}:${workItems.length}`,
      taskId,
      iteration: 0,
      prompt: decision.nextPrompt!,
      findings: [],
      kind: "continuation",
      continuationIteration,
    });
    outcome.taskId = taskId;
    outcome.status = "submitted";
    outcome.result = undefined;
    outcome.validation = undefined;
    outcome.decision = undefined;
    outcome.verification = undefined;
    this.requests.set(outcome.id, { ...request, prompt: decision.nextPrompt! });
  }

  private recordDecision(
    outcome: OrchestrationOutcome,
    decision: ChiefEngineerDecision,
    action: ChiefEngineerAuditRecord["action"],
    correctiveIterations: number,
    continuationIteration: number,
    reason = decision.reason,
  ): ChiefEngineerAuditRecord {
    const record = {
      ...decision,
      review: {
        proven: [...decision.review.proven],
        rootCause: [...decision.review.rootCause],
        fixed: [...decision.review.fixed],
        tests: [...decision.review.tests],
        unresolved: [...decision.review.unresolved],
        newProblems: [...decision.review.newProblems],
      },
      continuationAttestations: decision.continuationAttestations ? {
        safety: { ...decision.continuationAttestations.safety },
        scope: { ...decision.continuationAttestations.scope },
        risk: { ...decision.continuationAttestations.risk },
      } : undefined,
      action, reason, taskId: outcome.taskId, correctiveIterations,
      continuationIteration, timestamp: this.now() };
    this.chiefEngineerHistory.get(outcome.id)!.push(record);
    return record;
  }

  private recordStop(
    outcome: OrchestrationOutcome,
    decision: ChiefEngineerDecision,
    action: "BLOCKED" | "LIMIT_REACHED",
    correctiveIterations: number,
    continuationIteration: number,
    reason: string,
  ): ChiefEngineerStopResult {
    const record = this.recordDecision(outcome, decision, action, correctiveIterations,
      continuationIteration, reason);
    outcome.status = action === "LIMIT_REACHED" ? "continuation-limit-reached" : "blocked";
    return { status: action, reason, nextStep: record.nextStep,
      question: record.question, recommendedOption: record.recommendedOption };
  }

  private recordPolicyFailure(
    outcome: OrchestrationOutcome,
    correctiveIterations: number,
    continuationIteration: number,
    error: unknown,
  ): ChiefEngineerStopResult {
    const detail = error instanceof Error ? error.message : String(error);
    const reason = `Chief Engineer continuation review failed closed: ${detail}`;
    const decision: ChiefEngineerDecision = {
      action: "BLOCKED",
      review: {
        proven: [], rootCause: [detail], fixed: [], tests: [],
        unresolved: ["A valid continuation decision was not produced"], newProblems: [],
      },
      reason,
      nextStep: "Correct the continuation policy decision and rerun review; no continuation was submitted",
    };
    return this.recordStop(outcome, decision, "BLOCKED", correctiveIterations,
      continuationIteration, reason);
  }

  private getRequest(id: string): OrchestrationRequest {
    const request = this.requests.get(id);

    if (!request) {
      throw new Error(`Orchestration request ${id} was not found`);
    }

    return request;
  }

  private resolveStatus(taskStatus: TaskStatus): OrchestrationStatus {
    if (taskStatus === "pending" || taskStatus === "running") {
      return "waiting-for-work";
    }

    if (taskStatus === "failed") {
      return "failed";
    }

    if (taskStatus === "interrupted") {
      return "interrupted";
    }

    return "completed";
  }

  private createPilotResult(): PilotResult {
    return {
      mode: "pilot",
      status: "PILOT",
      findings: [PILOT_MODE_FINDING],
    };
  }
}

function formatFollowUpPrompt(prompt: string, findings: readonly string[]): string {
  return `${prompt}\n\nDecision Authority findings:\n${findings.map((finding) => `- ${finding}`).join("\n")}`;
}

function isFailResult(
  value: OrchestrationExecutionResult,
): value is DecisionResult | VerificationResult {
  return value.status === "FAIL";
}

function isPilotResult(value: OrchestrationExecutionResult): value is PilotResult {
  return value.status === "PILOT";
}

function toStopResult(decision: ChiefEngineerDecision): ChiefEngineerStopResult {
  if (decision.action === "CONTINUE" || decision.action === "COMPLETE") {
    throw new Error("Chief Engineer decision is not a stop result");
  }
  return { status: decision.action, reason: decision.reason, nextStep: decision.nextStep,
    question: decision.question, recommendedOption: decision.recommendedOption };
}

function mergeFindings(
  validation: ValidationDecision | undefined,
  findings: readonly string[],
): readonly string[] {
  return [...new Set([...(validation?.findings ?? []), ...findings])];
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isTerminal(status: OrchestrationStatus): boolean {
  return (
    status === "completed" ||
    status === "pilot-completed" ||
    status === "awaiting-decision" ||
    status === "blocked" ||
    status === "continuation-limit-reached" ||
    status === "failed" ||
    status === "interrupted"
  );
}
