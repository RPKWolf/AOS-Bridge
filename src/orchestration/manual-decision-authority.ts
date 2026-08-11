import type {
  DecisionAuthority,
  DecisionResult,
  DecisionStatus,
  OrchestrationRequest,
  ValidatedResult,
} from "./contracts";

export class ManualDecisionAuthority implements DecisionAuthority {
  public constructor(
    private readonly decision: DecisionStatus,
    private readonly findings: readonly string[] = [],
    private readonly authorityId = "manual",
  ) {}

  public async decide(
    _request: OrchestrationRequest,
    _validatedResult: ValidatedResult,
  ): Promise<DecisionResult> {
    return {
      status: this.decision,
      findings: this.findings,
      authorityId: this.authorityId,
    };
  }
}
