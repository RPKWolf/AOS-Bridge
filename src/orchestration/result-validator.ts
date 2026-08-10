import type {
  OrchestrationRequest,
  ResultValidator,
  ValidationDecision,
} from "./contracts";
import type { TaskResult } from "../types/task";

export class PassResultValidator implements ResultValidator {
  public constructor(private readonly authorityId = "mvp-result-validator") {}

  public async validate(
    _request: OrchestrationRequest,
    _result: TaskResult,
  ): Promise<ValidationDecision> {
    return {
      status: "PASS",
      findings: [],
      authorityId: this.authorityId,
    };
  }
}
