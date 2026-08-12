import type { ChiefEngineerDecision } from "./contracts";

export function validateChiefEngineerDecision(decision: ChiefEngineerDecision): void {
  if (!decision.nextStep.trim() || !decision.reason.trim()) {
    throw new Error("Chief Engineer decision requires a next step and reason");
  }

  if (decision.action === "CONTINUE" && !decision.nextPrompt?.trim()) {
    throw new Error("Chief Engineer CONTINUE decision requires a next prompt");
  }

  if (
    decision.action === "USER_DECISION_REQUIRED" &&
    (!decision.question?.trim() || !decision.recommendedOption?.trim())
  ) {
    throw new Error(
      "Chief Engineer USER_DECISION_REQUIRED decision requires one question and a recommended option",
    );
  }
}

export function formatContinuationPrompt(decision: ChiefEngineerDecision): string {
  return `${decision.nextPrompt}\n\nChief Engineer continuation reason:\n${decision.reason}`;
}
