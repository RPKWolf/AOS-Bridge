export const WORK_EXECUTION_POLICY = `Mandatory execution policy:
- Continue observing every submitted Bridge task while it is pending or running. Do not stop after Submit or report running as a final outcome. Read the Result after a terminal completed status and evaluate it against the acceptance criteria.
- Before any AOS runtime or start test, inspect existing AOS, Immediate, Python Service, and npm runtime processes/services. Never start a duplicate instance blindly. Reuse a suitable existing runtime; when a clean start is required, stop the relevant AOS components in a controlled way and then start exactly one instance.
- IBKR execution is Paper-only. Treat any Live configuration, account, route, or ambiguity as a blocker and fail closed without placing or enabling Live activity.`;

export function applyWorkExecutionPolicy(prompt: string): string {
  return `${WORK_EXECUTION_POLICY}\n\nWork request:\n${prompt}`;
}
