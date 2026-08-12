import type { ChiefEngineerDecision } from "./contracts";

const ACTIONS = new Set(["CONTINUE", "COMPLETE", "USER_DECISION_REQUIRED", "BLOCKED"]);

export function validateChiefEngineerDecision(decision: unknown): asserts decision is ChiefEngineerDecision {
  if (!isRecord(decision) || typeof decision.action !== "string" || !ACTIONS.has(decision.action)) {
    throw new Error("Chief Engineer decision requires a valid action");
  }
  if (typeof decision.nextStep !== "string" || typeof decision.reason !== "string" ||
    !decision.nextStep.trim() || !decision.reason.trim()) {
    throw new Error("Chief Engineer decision requires a next step and reason");
  }

  validateReview(decision.review);

  if (decision.action === "CONTINUE") {
    if (typeof decision.nextPrompt !== "string" || !decision.nextPrompt.trim()) {
      throw new Error("Chief Engineer CONTINUE decision requires a next prompt");
    }
    validateContinuationAttestations(decision.continuationAttestations);
  }

  if (
    decision.action === "USER_DECISION_REQUIRED" &&
    (typeof decision.question !== "string" || !decision.question.trim() ||
      typeof decision.recommendedOption !== "string" || !decision.recommendedOption.trim())
  ) {
    throw new Error(
      "Chief Engineer USER_DECISION_REQUIRED decision requires one question and a recommended option",
    );
  }
}

function validateContinuationAttestations(value: unknown): void {
  if (!isRecord(value)) {
    throw new Error("Chief Engineer CONTINUE decision requires safety, scope, and risk attestations");
  }
  for (const boundary of ["safety", "scope", "risk"] as const) {
    const attestation = value[boundary];
    if (!isRecord(attestation) || attestation.preserved !== true ||
      typeof attestation.evidence !== "string" || !attestation.evidence.trim()) {
      throw new Error(`Chief Engineer CONTINUE ${boundary} boundary is not positively attested with evidence`);
    }
  }
}

function validateReview(value: unknown): void {
  if (!isRecord(value)) throw new Error("Chief Engineer decision requires a technical review");
  for (const field of ["proven", "rootCause", "fixed", "tests", "unresolved", "newProblems"] as const) {
    if (!Array.isArray(value[field]) || !value[field].every((entry) => typeof entry === "string")) {
      throw new Error(`Chief Engineer technical review requires a string array for ${field}`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function formatContinuationPrompt(decision: ChiefEngineerDecision): string {
  return `${decision.nextPrompt}\n\nChief Engineer continuation reason:\n${decision.reason}`;
}
