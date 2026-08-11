import { TaskNotCompletedError } from "../errors/bridge-error";
import type { TaskResult, TaskStatus } from "../types/task";
import type {
  AgentSelector,
  BridgeTaskClient,
  DecisionAuthority,
  DecisionResult,
  OrchestrationExecutionResult,
  OrchestrationOutcome,
  OrchestrationRequest,
  OrchestrationStatus,
  PilotResult,
  ResultValidator,
  ValidatedResult,
  WorkItem,
} from "./contracts";

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
  ) {}

  public async start(request: OrchestrationRequest): Promise<OrchestrationOutcome> {
    const agent = this.selector.select(request);
    const taskId = await this.bridgeTaskClient.submitTask(request.prompt);
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
    const firstResult = await this.waitForCompletion(outcome);
    const firstDecision = await this.applyDecision(outcome, firstResult);

    if (!isFailDecision(firstDecision) || !outcome.decision) {
      return firstDecision;
    }

    await this.startFollowUpIteration(outcome, request, firstDecision.findings);
    const followUpResult = await this.waitForCompletion(outcome);
    return this.applyDecision(outcome, followUpResult);
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
      outcome.status = "completed";
      return result;
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

    return result;
  }

  private async startFollowUpIteration(
    outcome: OrchestrationOutcome,
    request: OrchestrationRequest,
    findings: readonly string[],
  ): Promise<void> {
    const taskId = await this.bridgeTaskClient.submitTask(
      formatFollowUpPrompt(request.prompt, findings),
    );
    const workItems = this.workItems.get(outcome.id);

    if (!workItems) {
      throw new Error(`Orchestration ${outcome.id} was not found`);
    }

    workItems.push({
      id: `${outcome.id}:1`,
      taskId,
      iteration: 1,
      prompt: request.prompt,
      findings,
    });
    outcome.taskId = taskId;
    outcome.status = "submitted";
    outcome.result = undefined;
    outcome.validation = undefined;
    outcome.decision = undefined;
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

function isFailDecision(value: OrchestrationExecutionResult): value is DecisionResult {
  return value.status === "FAIL";
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
