import type { TaskResult } from "../types/task";
import type {
  DecisionAuthority,
  DecisionResult,
  DecisionStatus,
  OrchestrationRequest,
} from "./contracts";

export class ManualDecisionAuthority implements DecisionAuthority {
  public constructor(
    private readonly decision: DecisionStatus,
    private readonly findings: readonly string[] = [],
    private readonly authorityId = "manual",
  ) {}

  public async decide(
    _request: OrchestrationRequest,
    _result: TaskResult,
  ): Promise<DecisionResult> {
    return {
      status: this.decision,
      findings: this.findings,
      authorityId: this.authorityId,
    };
  }
}
