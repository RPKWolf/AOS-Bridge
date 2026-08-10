import { TaskNotCompletedError } from "../errors/bridge-error";
import type { TaskResult, TaskStatus } from "../types/task";
import type {
  AgentSelector,
  BridgeTaskClient,
  DecisionAuthority,
  DecisionResult,
  OrchestrationOutcome,
  OrchestrationRequest,
  OrchestrationStatus,
  ResultValidator,
} from "./contracts";

export class OrchestrationCoordinator {
  private readonly outcomes = new Map<string, OrchestrationOutcome>();
  private readonly requests = new Map<string, OrchestrationRequest>();

  public constructor(
    private readonly selector: AgentSelector,
    private readonly bridgeTaskClient: BridgeTaskClient,
    _resultValidator?: ResultValidator,
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
      status: "submitted",
    };

    this.outcomes.set(request.id, outcome);
    this.requests.set(request.id, request);
    return outcome;
  }

  public async execute(request: OrchestrationRequest): Promise<TaskResult | DecisionResult> {
    const outcome = await this.start(request);

    while (true) {
      const status = await this.getStatus(outcome.id);

      if (status === "completed") {
        const result = await this.bridgeTaskClient.getResult(outcome.taskId);
        outcome.result = result;

        if (!this.decisionAuthority) {
          return result;
        }

        const decision = await this.decisionAuthority.decide(
          this.getRequest(outcome.id),
          result,
        );
        outcome.decision = decision;

        if (decision.status === "PASS") {
          return result;
        }

        outcome.status = "failed";
        return decision;
      }

      if (status === "failed" || status === "interrupted") {
        throw new TaskNotCompletedError(
          `Orchestration ${outcome.id} ended with status ${status}`,
        );
      }

      await delay(this.pollIntervalMilliseconds);
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
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isTerminal(status: OrchestrationStatus): boolean {
  return status === "completed" || status === "failed" || status === "interrupted";
}
