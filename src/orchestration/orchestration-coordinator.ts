import { TaskNotCompletedError } from "../errors/bridge-error";
import type { TaskResult, TaskStatus } from "../types/task";
import type {
  AgentSelector,
  BridgeTaskClient,
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

const PILOT_MODE_FINDING =
  "Pilot Mode: validation is disabled, so the worker output is not a final orchestration result.";

export class OrchestrationCoordinator {
  private readonly outcomes = new Map<string, OrchestrationOutcome>();
  private readonly requests = new Map<string, OrchestrationRequest>();
  private readonly workItems = new Map<string, WorkItem[]>();

  public constructor(
    private readonly selector: AgentSelector,
    private readonly bridgeTaskClient: BridgeTaskClient,
    private readonly resultValidator?: ResultValidator,
    private readonly pollIntervalMilliseconds = 1_000,
    private readonly decisionAuthority?: DecisionAuthority,
    private readonly operationVerifier?: OperationVerifier,
  ) {}

  public async start(request: OrchestrationRequest): Promise<OrchestrationOutcome> {
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
    return outcome;
  }

  public async execute(request: OrchestrationRequest): Promise<OrchestrationExecutionResult> {
    const outcome = await this.start(request);
    for (let iteration = 0; ; iteration += 1) {
      const result = await this.waitForCompletion(outcome);
      const decision = await this.applyDecision(outcome, result);

      if (
        !isFailResult(decision) ||
        iteration >= request.maxIterations ||
        (!outcome.validation && !outcome.decision && !outcome.verification)
      ) {
        return decision;
      }

      await this.startFollowUpIteration(outcome, request, decision.findings, iteration + 1);
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
      id: `${outcome.id}:${iteration}`,
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
    status === "failed" ||
    status === "interrupted"
  );
}
