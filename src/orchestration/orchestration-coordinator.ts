import type { TaskStatus } from "../types/task";
import type {
  AgentSelector,
  BridgeTaskClient,
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
    private readonly resultValidator: ResultValidator,
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

  public async getStatus(id: string): Promise<OrchestrationStatus> {
    const outcome = this.getOutcome(id);

    if (isTerminal(outcome.status)) {
      return outcome.status;
    }

    const taskStatus = await this.bridgeTaskClient.getStatus(outcome.taskId);
    outcome.status = await this.resolveStatus(outcome, taskStatus);
    return outcome.status;
  }

  public getOutcome(id: string): OrchestrationOutcome {
    const outcome = this.outcomes.get(id);

    if (!outcome) {
      throw new Error(`Orchestration ${id} was not found`);
    }

    return outcome;
  }

  private async resolveStatus(
    outcome: OrchestrationOutcome,
    taskStatus: TaskStatus,
  ): Promise<OrchestrationStatus> {
    if (taskStatus === "pending" || taskStatus === "running") {
      return "waiting-for-work";
    }

    if (taskStatus === "failed") {
      return "failed";
    }

    if (taskStatus === "interrupted") {
      return "interrupted";
    }

    const result = await this.bridgeTaskClient.getResult(outcome.taskId);
    const request = this.requests.get(outcome.id);

    if (!request) {
      throw new Error(`Orchestration request ${outcome.id} was not found`);
    }

    const decision = await this.resultValidator.validate(request, result);

    outcome.result = result;
    outcome.decision = decision;
    return decision.status === "PASS" ? "completed" : "failed";
  }
}

function isTerminal(status: OrchestrationStatus): boolean {
  return status === "completed" || status === "failed" || status === "interrupted";
}
